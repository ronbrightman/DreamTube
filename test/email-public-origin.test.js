// test/email-public-origin.test.js
//
// Regression coverage for tracker item
// for-product-bug-two-blank-square-emails--3fvxvc: "two emails reached the
// founder that rendered with a blank square where an image should have
// been."
//
// THE BUG. Every absolute URL in this codebase's retention emails -- the
// lib/email-layout.js shell's own logo <img src>, the real-thumbnail
// <img src>, the profile/create CTA links, and the legally-required
// unsubscribe link -- was derived straight from the INBOUND REQUEST's
// `x-forwarded-host || host` header. That works for every sender driven by
// a real public HTTP request (dream-webhook.js runs under fal's webhook
// POST, send-first-dream-email.js under the browser's own call), and it is
// this codebase's established convention for reconstructing its own origin
// (request-password-reset.js, lib/dream-share-token.js, ...).
//
// But since commit de124a5 (2026-08-04) the ONLY path that actually sends
// the automatic first-dream retention email is
// send-pending-first-dream-emails.js -- a SCHEDULED function. A scheduled
// invocation has no public inbound request behind it at all (Netlify's own
// "Clockwork" scheduler calls it internally; there is no visitor-facing
// Host to reconstruct), so `'https://' + host` collapsed to the literal
// string `'https://'` and the shell emitted:
//
//     <img src="https:///assets/logo-v4.png" width="40" height="40" ... />
//
// which the URL parser resolves to the host `assets` -- a domain this app
// does not own -- so it never loads, and an <img> with explicit
// width="40" height="40" that never loads renders as EXACTLY a 40x40
// BLANK SQUARE. That is the founder's blank square. The same defect also
// silently downgraded the real dream thumbnail to the flat-colour fallback
// (absoluteImageUrl returns null rather than emit a relative src, and
// production imageUrls ARE relative durable
// `/.netlify/functions/image-file?key=...` urls -- see
// upload-dream-thumbnail.js), and emitted `https://profile.html/`,
// `https://create.html/` and a `https://.netlify/...` unsubscribe link.
//
// WHY THE EXISTING SUITE MISSED IT: every test in
// test/send-pending-first-dream-emails.test.js calls
// `scanAndSend(fakeEvent({}))` -- faithfully modelling a real header-less
// scheduled invocation -- but none of them ever asserted on the URLs that
// came out the other side, only on which template branch was chosen. This
// file closes exactly that gap: it asserts on the resolved URLs
// themselves.
//
// Run with: node --test test/
//
// NOT MOCKED HERE beyond this repo's usual Blobs/fetch doubles: the HTML
// these assertions run against is the byte-for-byte real body this code
// hands to Resend, taken off the outbound fetch, not a re-derivation.

var test = require('node:test');
var assert = require('node:assert/strict');

var mockBlobs = require('./helpers/mock-blobs');
mockBlobs.install();

var { fakeEvent } = require('./helpers/fake-event');
var { markInstalledFetchAsTestDouble } = require('./helpers/fetch-double');

var pendingStore = require('../netlify/functions/lib/first-dream-email-pending-store');
var dreamStore = require('../netlify/functions/lib/dream-store');
var accountStore = require('../netlify/functions/lib/account-store');
var sendPending = require('../netlify/functions/send-pending-first-dream-emails');
var emailLayout = require('../netlify/functions/lib/email-layout');
var unsubscribeToken = require('../netlify/functions/lib/unsubscribe-token');

var realFetch = global.fetch;

/** Same split-by-URL fetch spy shape as test/send-pending-first-dream-emails.test.js's own. */
function installFetchSpy() {
  var resendCalls = [];
  global.fetch = async function (url, opts) {
    var urlStr = String(url);
    var body = opts && opts.body ? JSON.parse(opts.body) : null;
    if (urlStr.indexOf('api.resend.com') !== -1) {
      resendCalls.push({ url: urlStr, body: body });
      return { ok: true, status: 200, json: async function () { return {}; } };
    }
    if (urlStr.indexOf('/capture/') !== -1) {
      return { ok: true, status: 200, json: async function () { return {}; } };
    }
    throw new Error('unexpected fetch to ' + urlStr);
  };
  markInstalledFetchAsTestDouble();
  return { resendCalls: resendCalls };
}

var savedSiteUrl;
test.beforeEach(function () {
  global.fetch = realFetch;
  mockBlobs.reset();
  process.env.RESEND_API_KEY = 'resend-test-key';
  savedSiteUrl = process.env.URL;
  delete process.env.URL;
});
test.after(function () {
  global.fetch = realFetch;
  delete process.env.RESEND_API_KEY;
  if (savedSiteUrl === undefined) delete process.env.URL; else process.env.URL = savedSiteUrl;
});

async function registerAccount(username, email) {
  await accountStore.createAccount(fakeEvent({}), { username: username, password: 'realpassword1', email: email });
}

async function seedSyncedDream(username, operationName, imageUrl) {
  await dreamStore.upsertPrivateDream(fakeEvent({}), username, {
    id: 'dream-' + operationName,
    ownerHandle: '@' + username,
    caption: 'A test dream', style: 'Cinematic', mediaType: 'video',
    videoUrl: 'https://example.com/v.mp4', imageUrl: imageUrl || null,
    sourceOperationName: operationName
  });
}

/**
 * Pulls every `src="..."` / `href="..."` out of an email body. An email
 * client has no document base url, so EVERY one of these must already be a
 * fully-qualified, publicly-resolvable https url -- there is nothing for a
 * relative or empty-host one to resolve against.
 */
function extractUrls(html) {
  var out = [];
  var re = /(?:src|href)="([^"]*)"/g;
  var m;
  while ((m = re.exec(html)) !== null) out.push(m[1]);
  return out;
}

/**
 * The failure this whole file exists for: a url whose parsed HOST is not a
 * real app host. `https:///assets/logo-v4.png` parses to host `assets`,
 * `https:///profile.html` to host `profile.html` -- each a nonexistent
 * domain that renders as a broken image / dead link, never an exception.
 * So "did it throw" is NOT a usable check; the host itself has to be.
 */
function assertPubliclyResolvable(url, label) {
  var parsed;
  try { parsed = new URL(url); } catch (e) {
    assert.fail(label + ': ' + url + ' is not even a parseable absolute url (an email has no base url to resolve it against)');
  }
  assert.equal(parsed.protocol, 'https:', label + ': ' + url + ' must be https');
  assert.ok(
    /^[a-z0-9-]+(\.[a-z0-9-]+)+(:[0-9]+)?$/i.test(parsed.host),
    label + ': ' + url + ' resolves to host "' + parsed.host + '", which is not a real public hostname -- this is the blank-square bug (a broken <img src> renders as an empty box at its declared width/height)'
  );
  assert.ok(
    !/^(localhost|127\.|0\.0\.0\.0|\[)/i.test(parsed.host),
    label + ': ' + url + ' points at a non-public/loopback host -- unusable from a real inbox'
  );
}

function assertEveryUrlIsPublic(html, label) {
  var urls = extractUrls(html);
  assert.ok(urls.length > 0, label + ': expected the email to contain at least one url');
  urls.forEach(function (u) { assertPubliclyResolvable(u, label); });
}

// ---------------------------------------------------------------------------
// The actual regression: the scheduled send, invoked exactly the way Netlify
// really invokes it (no public Host header anywhere on the event).
// ---------------------------------------------------------------------------

test('REGRESSION (blank square): the scheduled first-dream send with NO host header must still emit a loadable logo <img>, not https:///assets/logo-v4.png', async function () {
  await registerAccount('nohost', 'nohost@example.com');
  await pendingStore.markPending(fakeEvent({}), 'mock:1:nohost', 'nohost', 'nohost@example.com');
  var record = await pendingStore.getPending(fakeEvent({}), 'mock:1:nohost');
  mockBlobs.seed(pendingStore.STORE_NAME, 'mock:1:nohost', Object.assign({}, record, {
    triggeredAt: Date.now() - sendPending.THUMBNAIL_WAIT_MS - 5000
  }));

  var spies = installFetchSpy();
  // fakeEvent({}) is exactly what a real Netlify scheduled invocation looks
  // like to this code -- no x-forwarded-host, no host.
  await sendPending.scanAndSend(fakeEvent({}));

  assert.equal(spies.resendCalls.length, 1, 'test setup: the deadline-passed record must actually have sent');
  var html = spies.resendCalls[0].body.html;

  assert.doesNotMatch(html, /src="https:\/\/\//, 'the empty-host url that renders as the founder\'s blank square must never be emitted');
  var logoSrc = (html.match(/<img[^>]*src="([^"]*logo[^"]*)"/) || [])[1];
  assert.ok(logoSrc, 'the shared shell must still render its logo <img>');
  assertPubliclyResolvable(logoSrc, 'logo');
});

test('REGRESSION: EVERY url in a header-less scheduled send (logo, CTAs, unsubscribe) is publicly resolvable', async function () {
  await registerAccount('allurls', 'allurls@example.com');
  await pendingStore.markPending(fakeEvent({}), 'mock:1:allurls', 'allurls', 'allurls@example.com');
  var record = await pendingStore.getPending(fakeEvent({}), 'mock:1:allurls');
  mockBlobs.seed(pendingStore.STORE_NAME, 'mock:1:allurls', Object.assign({}, record, {
    triggeredAt: Date.now() - sendPending.THUMBNAIL_WAIT_MS - 5000
  }));

  var spies = installFetchSpy();
  await sendPending.scanAndSend(fakeEvent({}));

  assertEveryUrlIsPublic(spies.resendCalls[0].body.html, 'header-less scheduled send');
});

test('REGRESSION: the legally-required unsubscribe link is a real, clickable url on a header-less scheduled send', async function () {
  await registerAccount('unsub', 'unsub@example.com');
  await pendingStore.markPending(fakeEvent({}), 'mock:1:unsub', 'unsub', 'unsub@example.com');
  var record = await pendingStore.getPending(fakeEvent({}), 'mock:1:unsub');
  mockBlobs.seed(pendingStore.STORE_NAME, 'mock:1:unsub', Object.assign({}, record, {
    triggeredAt: Date.now() - sendPending.THUMBNAIL_WAIT_MS - 5000
  }));

  var spies = installFetchSpy();
  await sendPending.scanAndSend(fakeEvent({}));

  var html = spies.resendCalls[0].body.html;
  var unsubHref = (html.match(/href="([^"]*unsubscribe-email[^"]*)"/) || [])[1];
  assert.ok(unsubHref, 'a retention email must carry an unsubscribe link (CAN-SPAM)');
  assertPubliclyResolvable(unsubHref, 'unsubscribe link');
});

test('REGRESSION: a REAL relative durable thumbnail url still becomes a real thumbnail <img> on a header-less scheduled send, not a silent downgrade to the flat-colour banner', async function () {
  // This is the shape production actually stores -- upload-dream-thumbnail.js
  // returns lib/media-rehost.js's durableUrl(), which is RELATIVE. The
  // existing suite only ever seeded an absolute `https://img.example/...`
  // url, which is why this downgrade was invisible.
  await registerAccount('relthumb', 'relthumb@example.com');
  await seedSyncedDream('relthumb', 'mock:1:relthumb', '/.netlify/functions/image-file?key=thumb%3Arelthumb%3Ad1');
  await pendingStore.markPending(fakeEvent({}), 'mock:1:relthumb', 'relthumb', 'relthumb@example.com');

  var spies = installFetchSpy();
  var result = await sendPending.scanAndSend(fakeEvent({}));

  assert.equal(result.sentWithImage, 1);
  var html = spies.resendCalls[0].body.html;
  assert.match(html, /object-fit:cover/, 'a synced real thumbnail must render as the real <img>, not fall back to the flat-colour banner just because the scheduled event had no Host header');
  var thumbSrc = (html.match(/<img[^>]*src="([^"]*image-file[^"]*)"/) || [])[1];
  assert.ok(thumbSrc, 'the real thumbnail <img> must carry the durable image-file url');
  assertPubliclyResolvable(thumbSrc, 'thumbnail');
  assertEveryUrlIsPublic(html, 'header-less scheduled send with real thumbnail');
});

// ---------------------------------------------------------------------------
// Request-driven sends emit the CANONICAL origin too -- the 08-08
// canonical-domain rule (lib/site-origin.js) retired the old
// "request host wins" convention: a request arriving on the Netlify
// alias must still email dreamtube.life links.
// ---------------------------------------------------------------------------

test('a request arriving on the Netlify alias still emails CANONICAL links -- the request host is ignored (08-08 rule)', async function () {
  await registerAccount('realhost', 'realhost@example.com');
  await pendingStore.markPending(fakeEvent({}), 'mock:1:realhost', 'realhost', 'realhost@example.com');
  var record = await pendingStore.getPending(fakeEvent({}), 'mock:1:realhost');
  mockBlobs.seed(pendingStore.STORE_NAME, 'mock:1:realhost', Object.assign({}, record, {
    triggeredAt: Date.now() - sendPending.THUMBNAIL_WAIT_MS - 5000
  }));

  var spies = installFetchSpy();
  await sendPending.scanAndSend(fakeEvent({ headers: { 'x-forwarded-host': 'dreamtube1.netlify.app' } }));

  var html = spies.resendCalls[0].body.html;
  assert.match(html, /https:\/\/dreamtube\.life\/assets\/logo-v4\.png/, 'an alias-host request must still emit canonical links, never echo the alias back');
  assert.doesNotMatch(html, /dreamtube1\.netlify\.app/, 'no Netlify-alias url may appear anywhere in a user-facing email (08-08 rule)');
  assertEveryUrlIsPublic(html, 'alias-host send');
});

// ---------------------------------------------------------------------------
// The origin resolver itself.
// ---------------------------------------------------------------------------

test('emailLayout.selfOrigin: the request host is IGNORED -- canonical origin even for an alias or deploy-preview host (08-08 rule)', function () {
  process.env.URL = 'https://dreamtube.life';
  assert.equal(emailLayout.selfOrigin(fakeEvent({ headers: { host: 'dreamtube1.netlify.app' } })), 'https://dreamtube.life');
  assert.equal(
    emailLayout.selfOrigin(fakeEvent({ headers: { host: 'wrong.example', 'x-forwarded-host': 'deploy-preview-9--dreamtube1.netlify.app' } })),
    'https://dreamtube.life',
    'a deploy-preview-triggered email carrying production links is the INTENDED behavior under the canonical rule'
  );
});

test('emailLayout.selfOrigin: a header-less event (the scheduled invocation) falls back to the configured site origin, never "https://"', function () {
  process.env.URL = 'https://dreamtube.life';
  assert.equal(emailLayout.selfOrigin(fakeEvent({})), 'https://dreamtube.life');
  assert.equal(emailLayout.selfOrigin(null), 'https://dreamtube.life', 'a missing event object must be just as safe as a header-less one');
});

test('emailLayout.selfOrigin: with no request host AND no configured URL, falls back to the canonical production host -- never an empty host', function () {
  delete process.env.URL;
  assert.equal(emailLayout.selfOrigin(fakeEvent({})), 'https://dreamtube.life');
});

test('emailLayout.selfOrigin: a non-public host (netlify dev\'s own localhost:8888, an ip literal, a bare hostname) is rejected -- an inbox cannot reach any of them', function () {
  delete process.env.URL;
  ['localhost:8888', 'localhost', '127.0.0.1', '10.0.0.4:8888', 'someinternalbox'].forEach(function (host) {
    assert.equal(
      emailLayout.selfOrigin(fakeEvent({ headers: { host: host } })),
      'https://dreamtube.life',
      host + ' must not end up as an email\'s origin'
    );
  });
});

test('emailLayout.selfOrigin: a CRLF/injection-shaped host header is rejected rather than embedded in email HTML', function () {
  delete process.env.URL;
  ['evil.example\r\nX-Injected: 1', 'evil.example/"><script>', 'evil.example ', ''].forEach(function (host) {
    assert.equal(emailLayout.selfOrigin(fakeEvent({ headers: { host: host } })), 'https://dreamtube.life', JSON.stringify(host) + ' must be rejected');
  });
});

test('unsubscribe links built from a header-less event are publicly resolvable too (same resolver, not a second copy that can drift)', function () {
  delete process.env.URL;
  var url = unsubscribeToken.buildUnsubscribeUrl(fakeEvent({}), 'someone@example.com');
  assertPubliclyResolvable(url, 'unsubscribe token url');
  assert.match(url, /^https:\/\/dreamtube\.life\/\.netlify\/functions\/unsubscribe-email\?/);
});
