// test/email-click-track-behavioral.test.js
//
// Behavioral coverage for js/email-click-track.js — the first-party
// "email link was clicked" tracker (founder ask 2026-08-16: email clicks were
// unmeasurable in our own analytics). Every email CTA appends ?ec=<type>; a
// landing page that loads this script turns that into an email_link_clicked
// PostHog event (and strips ec from the URL — same synchronous code path as
// the verified capture below).
//
// Drives the REAL script in a real browser (Chromium) against result.html
// (which loads it), following test/scroll-lock-behavioral.test.js's
// static-server + seeded-login conventions. Two things make this robust:
//  - a PostHog spy is pre-installed via addInitScript with __loaded=true so the
//    page's own PostHog snippet no-ops its re-init guard, keeping the spy live;
//  - the spy reports each capture through a context.exposeBinding callback, so
//    the recording survives result.html's own downstream navigation (it may
//    redirect for a bare seeded dream) — the head-script capture is what we
//    assert, and it fires before any redirect.

var test = require('node:test');
var assert = require('node:assert/strict');
var staticServer = require('./helpers/static-server');

var CHROMIUM_PATH = '/opt/pw-browsers/chromium';
var playwright = null, unavailableReason = null;
try { playwright = require('playwright'); }
catch (e1) {
  try { playwright = require('/opt/node22/lib/node_modules/playwright'); }
  catch (e2) { unavailableReason = 'Playwright not resolvable (' + e2.message + ')'; }
}

var server = null, browser = null, baseUrl = null;

test.before(async function () {
  if (unavailableReason) return;
  server = await staticServer.start();
  baseUrl = server.url;
  try { browser = await playwright.chromium.launch({ executablePath: CHROMIUM_PATH }); }
  catch (e) { unavailableReason = 'Could not launch Chromium: ' + e.message; }
});
test.after(async function () {
  if (browser) await browser.close();
  if (server) await server.close();
});

function blockThirdParty(page) {
  return page.route(/fonts\.(googleapis|gstatic)\.com|connect\.facebook\.net|i\.posthog\.com/, function (route) {
    route.abort();
  });
}

// A context whose PostHog capture() calls are reported to a Node-side array via
// exposeBinding (survives navigation), and whose spy pre-empts the page's own
// PostHog snippet (__loaded=true).
async function spiedContext() {
  var context = await browser.newContext({ viewport: { width: 390, height: 800 } });
  var captures = [];
  await context.exposeBinding('__ecRecord', function (source, name, props) {
    captures.push({ name: name, props: props });
  });
  await context.addInitScript(function () {
    window.posthog = new Proxy({ __loaded: true }, {
      get: function (t, k) {
        if (k === '__loaded') return true;
        if (k === 'capture') return function (n, p) { try { window.__ecRecord(n, p); } catch (e) {} };
        return function () {};
      }
    });
  });
  return { context: context, captures: captures };
}

async function seedLoggedInDream(page, id) {
  await page.goto(baseUrl + '/login.html', { waitUntil: 'domcontentloaded' });
  await page.evaluate(function (dreamId) {
    var s = {
      user: { handle: '@tester', username: 'tester' },
      accounts: { tester: { password: 'testpass1', email: 'tester@example.com' } },
      dreams: [{
        id: dreamId, ownerHandle: '@tester', caption: 'A dream about the sea',
        storyText: 'I walked along a glowing shore', style: 'Cinematic',
        videoUrl: 'https://example.com/v.mp4', imageUrl: 'https://img.example/t.jpg',
        sourceOperationName: 'op-' + dreamId, isPublished: false,
        createdAt: new Date().toISOString()
      }]
    };
    localStorage.setItem('dreamtube_state_v1', JSON.stringify(s));
  }, id);
}

test('email-click-track: an ?ec= arrival fires exactly one email_link_clicked carrying the email type + landing page', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var s = await spiedContext();
  try {
    var page = await s.context.newPage();
    await blockThirdParty(page);
    await seedLoggedInDream(page, 'ectrack1');
    await page.goto(baseUrl + '/result.html?id=ectrack1&ec=interp_none', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(700);

    var clicks = s.captures.filter(function (c) { return c.name === 'email_link_clicked'; });
    assert.equal(clicks.length, 1, 'fires exactly one email_link_clicked');
    assert.equal(clicks[0].props.email_type, 'interp_none', 'carries the email type from ?ec=');
    assert.equal(clicks[0].props.dest, '/result.html', 'records the landing page');
  } finally {
    await s.context.close();
  }
});

test('email-click-track: an ordinary page load with NO ?ec= fires nothing', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var s = await spiedContext();
  try {
    var page = await s.context.newPage();
    await blockThirdParty(page);
    await seedLoggedInDream(page, 'ectrack2');
    await page.goto(baseUrl + '/result.html?id=ectrack2', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(500);

    var clicks = s.captures.filter(function (c) { return c.name === 'email_link_clicked'; });
    assert.equal(clicks.length, 0, 'no email_link_clicked without an ec param');
  } finally {
    await s.context.close();
  }
});
