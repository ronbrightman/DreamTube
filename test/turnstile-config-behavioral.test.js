// test/turnstile-config-behavioral.test.js
//
// Real browser-driven coverage for js/turnstile-config.js's client-side
// behavior -- the interactive-overlay show/hide logic and the widget-
// cleanup-on-retry logic added across the last two turnstile-guardrail
// fix passes, plus the in-flight-call guard added in this pass. None of
// this was previously covered by any committed test: test/turnstile.test.js
// and test/generate-video-turnstile.test.js are both server-side only
// (netlify/functions/lib/turnstile.js's verify() and generate-video.js's
// E113 guardrail) -- neither ever loads js/turnstile-config.js in a real
// browser. This file follows the same node:test/assert + Playwright
// convention as test/ui-behavioral.test.js (see that file's own doc
// comment for the full rationale), driving test/fixtures/turnstile-
// fixture.html -- a minimal test-only page that loads js/turnstile-
// config.js exactly as processing.html does, but without processing.html's
// own auth-guard/generation-flow surface area -- against a faked
// window.turnstile stub instead of the real Cloudflare widget.
//
// Same environment caveat as test/ui-behavioral.test.js: if Playwright or
// the pinned Chromium binary isn't resolvable, every test below skips
// itself with a clear reason instead of failing the whole suite.

var test = require('node:test');
var assert = require('node:assert/strict');
var staticServer = require('./helpers/static-server');

var CHROMIUM_PATH = '/opt/pw-browsers/chromium';

var playwright = null;
var unavailableReason = null;
try {
  playwright = require('playwright');
} catch (e1) {
  try {
    playwright = require('/opt/node22/lib/node_modules/playwright');
  } catch (e2) {
    unavailableReason = 'Playwright is not resolvable in this environment (' + e2.message + ')';
  }
}

var server = null;
var browser = null;
var baseUrl = null;

test.before(async function () {
  if (unavailableReason) return;
  server = await staticServer.start();
  baseUrl = server.url;
  try {
    browser = await playwright.chromium.launch({ executablePath: CHROMIUM_PATH });
  } catch (e) {
    unavailableReason = 'Could not launch Chromium at ' + CHROMIUM_PATH + ': ' + e.message;
  }
});

test.after(async function () {
  if (browser) await browser.close();
  if (server) await server.close();
});

/**
 * Installs a fake window.turnstile on the context before any page script
 * runs (so it's already present when js/turnstile-config.js's
 * _loadTurnstileScript() checks `if (window.turnstile) return
 * Promise.resolve()` -- meaning no real script tag ever gets appended, no
 * network call to challenges.cloudflare.com ever happens).
 *
 * render(container, options) records { container, options } keyed by an
 * incrementing fake widget id in window.__turnstileWidgets, so a test can
 * reach back in and fire any of the callbacks (callback/error-callback/
 * before-interactive-callback/after-interactive-callback) exactly the way
 * the real Cloudflare widget would, from page.evaluate(). remove(id)
 * records removals in window.__turnstileRemovedIds and deletes the entry,
 * so "how many widgets are currently live" is always just
 * Object.keys(window.__turnstileWidgets).length.
 */
function installFakeTurnstile(context) {
  return context.addInitScript(function () {
    window.__turnstileWidgets = {};
    window.__turnstileNextId = 1;
    window.__turnstileRemovedIds = [];
    window.turnstile = {
      render: function (container, options) {
        var id = 'w' + (window.__turnstileNextId++);
        window.__turnstileWidgets[id] = { container: container, options: options };
        return id;
      },
      remove: function (id) {
        window.__turnstileRemovedIds.push(id);
        delete window.__turnstileWidgets[id];
      }
    };
  });
}

/** Sets TURNSTILE_SITE_KEY past the placeholder check -- js/turnstile-config.js declares it with `var` at top-level script scope (a plain, non-module <script>), so it's a regular writable global, same as any other var in this codebase's script-tag pattern (see CLAUDE.md). */
function enableTurnstile(page) {
  return page.evaluate(function () {
    window.TURNSTILE_SITE_KEY = 'test-sitekey';
  });
}

/** The single live widget's { id, container, options }, asserting there is exactly one -- every test below expects exactly one widget live at a time except the two that explicitly check for zero. */
async function getSoleWidget(page) {
  var ids = await page.evaluate(function () { return Object.keys(window.__turnstileWidgets); });
  assert.equal(ids.length, 1, 'expected exactly one live widget, found: ' + JSON.stringify(ids));
  var id = ids[0];
  var containerInfo = await page.evaluate(function (widgetId) {
    var c = window.__turnstileWidgets[widgetId].container;
    return {
      display: c.style.display,
      cssText: c.style.cssText,
      inDom: document.body.contains(c),
      ariaLive: c.getAttribute('aria-live')
    };
  }, id);
  return { id: id, container: containerInfo };
}

test('container starts hidden, before-interactive-callback promotes it to a visible centered overlay, and after-interactive-callback hides it again', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    await installFakeTurnstile(context);
    var page = await context.newPage();
    await page.goto(baseUrl + '/test/fixtures/turnstile-fixture.html', { waitUntil: 'domcontentloaded' });
    await enableTurnstile(page);

    await page.evaluate(function () { window.__p = getTurnstileToken(); });
    await page.waitForFunction(function () { return Object.keys(window.__turnstileWidgets).length === 1; }, null, { timeout: 5000 });

    // 1. Starts hidden.
    var widget = await getSoleWidget(page);
    assert.equal(widget.container.display, 'none', 'container should start hidden');
    assert.equal(widget.container.inDom, true, 'container should be appended to the DOM even while hidden');

    // 2. before-interactive-callback promotes it to a visible, centered overlay.
    await page.evaluate(function (id) {
      window.__turnstileWidgets[id].options['before-interactive-callback']();
    }, widget.id);
    var afterShow = await getSoleWidget(page);
    assert.match(afterShow.container.cssText, /position:\s*fixed/, 'expected a fixed-position overlay once interactive');
    assert.match(afterShow.container.cssText, /display:\s*flex/, 'expected the container to become visible (flex) once interactive');
    var computed = await page.evaluate(function (id) {
      var c = window.__turnstileWidgets[id].container;
      var cs = getComputedStyle(c);
      return { position: cs.position, display: cs.display };
    }, widget.id);
    assert.equal(computed.position, 'fixed');
    assert.equal(computed.display, 'flex');

    // 3. after-interactive-callback hides it again.
    await page.evaluate(function (id) {
      window.__turnstileWidgets[id].options['after-interactive-callback']();
    }, widget.id);
    var afterHide = await getSoleWidget(page);
    assert.equal(afterHide.container.display, 'none', 'container should be hidden again after the interactive challenge resolves');

    // Clean up: resolve the still-pending call so it doesn't leak a timer
    // past this test.
    await page.evaluate(function (id) {
      window.__turnstileWidgets[id].options.callback('cleanup-token');
    }, widget.id);
    await page.evaluate(function () { return window.__p; });
  } finally {
    await context.close();
  }
});

test('callback(token) resolving triggers cleanup: widget removed via turnstile.remove, container node removed from the DOM, and the token is what getTurnstileToken() resolves to', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    await installFakeTurnstile(context);
    var page = await context.newPage();
    await page.goto(baseUrl + '/test/fixtures/turnstile-fixture.html', { waitUntil: 'domcontentloaded' });
    await enableTurnstile(page);

    await page.evaluate(function () { window.__p = getTurnstileToken(); });
    await page.waitForFunction(function () { return Object.keys(window.__turnstileWidgets).length === 1; }, null, { timeout: 5000 });
    var widget = await getSoleWidget(page);

    await page.evaluate(function (id) {
      window.__turnstileWidgets[id].options.callback('real-token-abc');
    }, widget.id);

    var token = await page.evaluate(function () { return window.__p; });
    assert.equal(token, 'real-token-abc');

    var removedIds = await page.evaluate(function () { return window.__turnstileRemovedIds; });
    assert.deepEqual(removedIds, [widget.id], 'turnstile.remove() should have been called with exactly this widget id');

    var liveWidgetCount = await page.evaluate(function () { return Object.keys(window.__turnstileWidgets).length; });
    assert.equal(liveWidgetCount, 0, 'no widget should still be tracked as live after resolving');

    var containerStillInDom = await page.evaluate(function () {
      return document.querySelectorAll('[aria-live="polite"]').length;
    });
    assert.equal(containerStillInDom, 0, 'the container node should have been removed from the DOM, not just hidden');
  } finally {
    await context.close();
  }
});

test('sequential retry: a second getTurnstileToken() call made only after the first has already resolved tears down the old container and leaves exactly one live container/widget, never a leaked node', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    await installFakeTurnstile(context);
    var page = await context.newPage();
    await page.goto(baseUrl + '/test/fixtures/turnstile-fixture.html', { waitUntil: 'domcontentloaded' });
    await enableTurnstile(page);

    // First call, resolved to completion.
    await page.evaluate(function () { window.__p1 = getTurnstileToken(); });
    await page.waitForFunction(function () { return Object.keys(window.__turnstileWidgets).length === 1; }, null, { timeout: 5000 });
    var widget1 = await getSoleWidget(page);
    await page.evaluate(function (id) {
      window.__turnstileWidgets[id].options.callback('token-one');
    }, widget1.id);
    var token1 = await page.evaluate(function () { return window.__p1; });
    assert.equal(token1, 'token-one');

    // Second call, only started now that the first is fully settled --
    // this is the retry case (e.g. processing.html's "Try Again").
    await page.evaluate(function () { window.__p2 = getTurnstileToken(); });
    await page.waitForFunction(function () { return Object.keys(window.__turnstileWidgets).length === 1; }, null, { timeout: 5000 });
    var widget2 = await getSoleWidget(page);
    assert.notEqual(widget2.id, widget1.id, 'the second call should render a genuinely new widget');

    // Exactly one container in the DOM at this point -- the old one from
    // widget1 must have been fully removed already (it was, back when it
    // resolved above), and only widget2's is present now.
    var containerCount = await page.evaluate(function () {
      return document.querySelectorAll('[aria-live="polite"]').length;
    });
    assert.equal(containerCount, 1, 'exactly one container should exist at a time across sequential calls, no leaked node from the first');

    // Resolve the second call too, so nothing is left pending.
    await page.evaluate(function (id) {
      window.__turnstileWidgets[id].options.callback('token-two');
    }, widget2.id);
    var token2 = await page.evaluate(function () { return window.__p2; });
    assert.equal(token2, 'token-two');
  } finally {
    await context.close();
  }
});

test('concurrent call: getTurnstileToken() called again WHILE a prior call is still pending returns the SAME promise and does not tear down the active widget', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    await installFakeTurnstile(context);
    var page = await context.newPage();
    await page.goto(baseUrl + '/test/fixtures/turnstile-fixture.html', { waitUntil: 'domcontentloaded' });
    await enableTurnstile(page);

    // Both calls happen back-to-back, synchronously, in the same
    // evaluate() -- i.e. genuinely before the first has any chance to
    // settle, or even to render its widget (render() itself only happens
    // once _loadTurnstileScript()'s promise chain resolves on a later
    // microtask) -- and the promise-identity check itself has to happen
    // in-browser too, since Promise objects can't be compared for
    // identity across the Node/page.evaluate() boundary. _pendingTurnstile
    // TokenPromise is still set synchronously inside getTurnstileToken()
    // before it returns, though, so the identity check itself doesn't need
    // to wait for anything.
    var samePromise = await page.evaluate(function () {
      window.__p1 = getTurnstileToken();
      window.__p2 = getTurnstileToken();
      return window.__p1 === window.__p2;
    });
    assert.equal(samePromise, true, 'a second call made before the first settles must return the exact same promise');

    // Now wait for the (single) render to actually happen, and confirm it
    // really only happened once -- not that a second widget got rendered
    // and then torn back down to net out at one.
    await page.waitForFunction(function () { return Object.keys(window.__turnstileWidgets).length >= 1; }, null, { timeout: 5000 });
    var widget = await getSoleWidget(page);
    var removedCountAfterBoth = await page.evaluate(function () { return window.__turnstileRemovedIds.length; });
    assert.equal(removedCountAfterBoth, 0, 'the active widget must not be torn down just because a second call came in while it was still pending');

    // Resolving the one real widget resolves both promises (checked in
    // the next test, which also verifies a later, post-settle call gets a
    // genuinely fresh widget) -- this test's job is purely the
    // re-entrancy guard itself, so it settles the pending call only to
    // leave the page/context clean for close().
    await page.evaluate(function (id) {
      window.__turnstileWidgets[id].options.callback('shared-token');
    }, widget.id);
    var removedIds = await page.evaluate(function () { return window.__turnstileRemovedIds; });
    assert.equal(removedIds.length, 1, 'exactly one cleanup once the shared call finally resolves');
  } finally {
    await context.close();
  }
});

test('concurrent call resolves both original promises to the same token, and a later call (after settling) is a genuinely fresh one', async function (t) {
  if (unavailableReason) { t.skip(unavailableReason); return; }
  var context = await browser.newContext();
  try {
    await installFakeTurnstile(context);
    var page = await context.newPage();
    await page.goto(baseUrl + '/test/fixtures/turnstile-fixture.html', { waitUntil: 'domcontentloaded' });
    await enableTurnstile(page);

    await page.evaluate(function () {
      window.__p1 = getTurnstileToken();
      window.__p2 = getTurnstileToken();
    });
    await page.waitForFunction(function () { return Object.keys(window.__turnstileWidgets).length === 1; }, null, { timeout: 5000 });
    var widget = await getSoleWidget(page);

    await page.evaluate(function (id) {
      window.__turnstileWidgets[id].options.callback('shared-token-2');
    }, widget.id);

    var tokens = await page.evaluate(function () {
      return Promise.all([window.__p1, window.__p2]);
    });
    assert.deepEqual(tokens, ['shared-token-2', 'shared-token-2'], 'both the original and the concurrent call should resolve to the same real token');

    // Now that it's settled, a fresh call must render a genuinely new
    // widget rather than returning the stale settled promise forever.
    await page.evaluate(function () { window.__p3 = getTurnstileToken(); });
    await page.waitForFunction(function () { return Object.keys(window.__turnstileWidgets).length === 1; }, null, { timeout: 5000 });
    var widget2 = await getSoleWidget(page);
    assert.notEqual(widget2.id, widget.id, 'a call made after the pending one settles should render a fresh widget, not reuse the stale promise');

    await page.evaluate(function (id) {
      window.__turnstileWidgets[id].options.callback('token-three');
    }, widget2.id);
    await page.evaluate(function () { return window.__p3; });
  } finally {
    await context.close();
  }
});
