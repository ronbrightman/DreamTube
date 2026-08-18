// js/generation-fail-panel.js
//
// GenerationFailPanel — the PERSISTENT recovery panel shown on a plain
// technical generation failure (NOT the E116 content-policy block, which
// keeps its own richer ContentBlockPanel with Soften/Edit/Discard — see
// that file's own header comment; this is the OTHER, simpler branch of the
// same catch handler). Recovery-UX part (b), tracker item
// for-product-track-avg-video-generation-t-2ci8ue (founder ask 2026-08-10:
// "always show a clear 'your tokens were returned — tap to try again'
// recovery UI on the failure screen"). Before this, a plain technical
// failure (fal error, poll timeout, network exhaustion — anything that
// isn't E112/E412 insufficient-tokens or E116 content-policy) surfaced as a
// vanishing toast, auto-dismissed in ~2.2s, with nothing to tap.
//
// Sibling component to ContentBlockPanel (js/content-block-panel.js), same
// sheet/overlay visual language and "stays until the user acts" dismiss
// pattern, deliberately simpler: just the failure message, a prominent
// "Your tokens were returned" line when a refund actually landed, a single
// "Try again" button, and a dismiss affordance — no text-editing options
// (there's no blocked text to revise here, just a technical failure to
// retry from the still-intact draft).
//
// Plain script (matches store.js/content-block-panel.js's convention — no
// ES modules, no bundler; see CLAUDE.md). Loaded after js/store.js on any
// page that can submit a generation and surface a plain technical failure
// (home.html today — see that page's own generic-failure catch branch).

var GenerationFailPanel = (function () {
  var STYLE_ID = 'gfp-style';
  var ROOT_ID = 'gfp-root';

  // Same overlay/sheet shape as ContentBlockPanel's own #cbp-root/.cbp-sheet
  // — a distinct id/class prefix throughout so both components can coexist
  // in the DOM (and each other's stylesheet) with zero risk of collision,
  // even though close() on each only ever touches its own root.
  var CSS = [
    '#' + ROOT_ID + '{position:fixed;inset:0;z-index:9999;display:flex;align-items:flex-end;justify-content:center;background:rgba(6,5,16,.66);padding:0;}',
    '@media (min-width:560px){#' + ROOT_ID + '{align-items:center;}}',
    '.gfp-sheet{width:100%;max-width:460px;background:#171126;color:#f3f0ff;border:1px solid rgba(255,255,255,.10);border-radius:20px 20px 0 0;padding:22px 20px calc(20px + env(safe-area-inset-bottom,0px));box-shadow:0 -8px 40px rgba(0,0,0,.5);}',
    '@media (min-width:560px){.gfp-sheet{border-radius:20px;margin:0 16px;}}',
    '.gfp-title{font-size:16px;font-weight:800;margin:0 0 8px;letter-spacing:-.01em;}',
    // The failure message: MUST wrap (multi-line, readable on a 390px
    // phone) — same "never nowrap" requirement as ContentBlockPanel's own
    // .cbp-msg.
    '.gfp-msg{font-size:14.5px;line-height:1.5;white-space:normal;color:#d9d3f0;margin:0 0 10px;}',
    // The refund line: deliberately its own visually distinct, high-
    // contrast row (not folded into .gfp-msg as a trailing sentence) — the
    // founder's own ask was a "CLEAR, prominent" statement, not just
    // present-somewhere-in-the-copy.
    '.gfp-refund{font-size:14.5px;line-height:1.45;font-weight:800;color:#8ef0c0;margin:0 0 18px;}',
    '.gfp-actions{display:flex;flex-direction:column;gap:10px;}',
    '.gfp-btn{width:100%;border:0;border-radius:99px;padding:13px 18px;font-size:15px;font-weight:700;cursor:pointer;font-family:inherit;-webkit-tap-highlight-color:transparent;}',
    '.gfp-btn-primary{background:linear-gradient(135deg,#7b5cff,#a35aff 55%,#e078be);color:#fff;}',
    '.gfp-btn-ghost{background:transparent;color:#a79fc9;}'
  ].join('');

  function injectStyleOnce() {
    if (document.getElementById(STYLE_ID)) return;
    var s = document.createElement('style');
    s.id = STYLE_ID;
    s.textContent = CSS;
    document.head.appendChild(s);
  }

  function close() {
    var root = document.getElementById(ROOT_ID);
    if (root && root.parentNode) root.parentNode.removeChild(root);
  }

  /** Builds a button element — same shape as ContentBlockPanel's own btn() helper. */
  function btn(label, cls, onClick) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'gfp-btn ' + cls;
    b.textContent = label;
    b.addEventListener('click', onClick);
    return b;
  }

  /**
   * opts:
   *   message        (string)  the failure copy (media-aware base copy +
   *                            the server's own reason suffix, when
   *                            present) — assembled by the caller, shown
   *                            as-is
   *   tokensRefunded (bool)    show the prominent "Your tokens were
   *                            returned." line — only ever true when the
   *                            caller's own err.tokensRefunded (set
   *                            server-side, see js/store.js's pollUntilDone)
   *                            says a refund genuinely landed; never
   *                            assumed here
   *   onRetry        (fn)      "Try again" — caller resubmits from the
   *                            still-intact draft; this component never
   *                            invents its own retry mechanism
   *   onDismiss      (fn)      optional — dismiss cleanup
   */
  function show(opts) {
    opts = opts || {};
    var onRetry = typeof opts.onRetry === 'function' ? opts.onRetry : function () {};
    var onDismiss = typeof opts.onDismiss === 'function' ? opts.onDismiss : function () {};

    injectStyleOnce();
    close(); // never stack two panels — same discipline as ContentBlockPanel.show()

    var root = document.createElement('div');
    root.id = ROOT_ID;
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');

    var sheet = document.createElement('div');
    sheet.className = 'gfp-sheet';

    var title = document.createElement('div');
    title.className = 'gfp-title';
    title.textContent = 'Something went wrong';
    sheet.appendChild(title);

    var msg = document.createElement('div');
    msg.className = 'gfp-msg';
    msg.textContent = opts.message || 'Something went wrong generating your dream — nothing was lost.';
    sheet.appendChild(msg);

    if (opts.tokensRefunded) {
      var refund = document.createElement('div');
      refund.className = 'gfp-refund';
      refund.textContent = 'Your tokens were returned.';
      sheet.appendChild(refund);
    }

    var actions = document.createElement('div');
    actions.className = 'gfp-actions';
    actions.appendChild(btn('Try again', 'gfp-btn-primary', function () {
      close();
      onRetry();
    }));
    actions.appendChild(btn('Dismiss', 'gfp-btn-ghost', function () {
      close();
      onDismiss();
    }));
    sheet.appendChild(actions);

    root.appendChild(sheet);
    document.body.appendChild(root);
  }

  return { show: show, close: close };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = GenerationFailPanel;
}
