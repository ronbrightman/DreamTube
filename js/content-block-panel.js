// js/content-block-panel.js
//
// ContentBlockPanel — the PERSISTENT recovery panel shown when the content-
// tier safety gate blocks a dream as explicit (founder upgrade 2026-08-08).
// Plain script (matches store.js / music-bed.js convention — no ES modules,
// no bundler; see CLAUDE.md), loaded after js/store.js on every page that can
// submit a generation and surface an E116/E12 content block (home.html,
// result.html).
//
// WHY A PANEL, NOT A TOAST: the block used to surface as a toast that auto-
// dismissed in ~1s and ran off the right edge on a phone — the founder
// couldn't read it, and there was nothing to DO about it. He also found that
// manually editing the text to be less explicit already lets it generate. So
// the block becomes a recovery moment: a modal that STAYS until the user
// acts, with three actions —
//   1. "Soften it for me" — POST /.netlify/functions/soften-dream-text, which
//      rewrites the dream to remove explicit content AND re-runs the content
//      gate on the rewrite. Only a rewrite that now PASSES the gate is handed
//      back to the editable field for the user to review and generate; a
//      rewrite that's still explicit re-shows this panel with a "couldn't
//      soften it enough" note. Hidden for the named-other-person case (see
//      below) — softening can't help there.
//   2. "Edit it myself" — hands the user's ORIGINAL text back to the editable
//      field so they can revise it (exactly the manual recovery the founder
//      did).
//   3. "Discard" — cancel, nothing generated, nothing charged.
//
// NAMED-OTHER-PERSON case: when the block is the stricter anti-NCII rule (a
// named + photographed real person, which blocks romantic too), softening
// does not help, so "Soften it for me" is hidden. The caller passes
// namedPerson:true (it knows from the gate reason). This panel never itself
// calls generation — the page-supplied onApplyText(text) callback routes the
// (softened or original) text into that page's own editable dream-text field,
// where the normal Generate flow re-gates server-side one more time.

var ContentBlockPanel = (function () {
  var STYLE_ID = 'cbp-style';
  var ROOT_ID = 'cbp-root';

  var CSS = [
    '#' + ROOT_ID + '{position:fixed;inset:0;z-index:9999;display:flex;align-items:flex-end;justify-content:center;background:rgba(6,5,16,.66);padding:0;}',
    '@media (min-width:560px){#' + ROOT_ID + '{align-items:center;}}',
    '.cbp-sheet{width:100%;max-width:460px;background:#171126;color:#f3f0ff;border:1px solid rgba(255,255,255,.10);border-radius:20px 20px 0 0;padding:22px 20px calc(20px + env(safe-area-inset-bottom,0px));box-shadow:0 -8px 40px rgba(0,0,0,.5);}',
    '@media (min-width:560px){.cbp-sheet{border-radius:20px;margin:0 16px;}}',
    '.cbp-title{font-size:16px;font-weight:800;margin:0 0 8px;letter-spacing:-.01em;}',
    // The block message: MUST wrap (multi-line, readable on a 390px phone) —
    // white-space:normal + comfortable line-height, never clipped.
    '.cbp-msg{font-size:14.5px;line-height:1.5;white-space:normal;color:#d9d3f0;margin:0 0 18px;}',
    '.cbp-note{font-size:13px;line-height:1.45;color:#ffd7a8;margin:0 0 16px;}',
    '.cbp-actions{display:flex;flex-direction:column;gap:10px;}',
    '.cbp-btn{width:100%;border:0;border-radius:99px;padding:13px 18px;font-size:15px;font-weight:700;cursor:pointer;font-family:inherit;-webkit-tap-highlight-color:transparent;}',
    '.cbp-btn:disabled{opacity:.55;cursor:default;}',
    '.cbp-btn-primary{background:linear-gradient(135deg,#7b5cff,#a35aff 55%,#e078be);color:#fff;}',
    '.cbp-btn-secondary{background:rgba(255,255,255,.09);color:#f3f0ff;border:1px solid rgba(255,255,255,.14);}',
    '.cbp-btn-ghost{background:transparent;color:#a79fc9;}',
    '.cbp-spin{display:inline-block;width:15px;height:15px;border:2px solid rgba(255,255,255,.4);border-top-color:#fff;border-radius:50%;vertical-align:-3px;margin-right:8px;animation:cbp-spin .7s linear infinite;}',
    '@keyframes cbp-spin{to{transform:rotate(360deg);}}',
    '@media (prefers-reduced-motion: reduce){.cbp-spin{animation:none;}}'
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

  /** Builds a button element. */
  function btn(label, cls, onClick) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'cbp-btn ' + cls;
    b.textContent = label;
    b.addEventListener('click', onClick);
    return b;
  }

  /**
   * opts:
   *   message       (string)  the block copy (server's own clean sentence)
   *   namedPerson   (bool)    hide "Soften it for me" (softening can't help)
   *   originalText  (string)  the dream text that was blocked
   *   onApplyText   (fn text) route this text into the page's editable field
   *   onDiscard     (fn)      optional — cancel cleanup
   */
  function show(opts) {
    opts = opts || {};
    var originalText = typeof opts.originalText === 'string' ? opts.originalText : '';
    var namedPerson = !!opts.namedPerson;
    var onApplyText = typeof opts.onApplyText === 'function' ? opts.onApplyText : function () {};
    var onDiscard = typeof opts.onDiscard === 'function' ? opts.onDiscard : function () {};

    injectStyleOnce();
    close(); // never stack two panels

    var root = document.createElement('div');
    root.id = ROOT_ID;
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');

    var sheet = document.createElement('div');
    sheet.className = 'cbp-sheet';
    root.appendChild(sheet);
    document.body.appendChild(root);

    // Renders the DEFAULT (initial or reset) state: message + actions.
    // `note` (optional) is a one-line explanation shown above the message
    // (e.g. after a failed soften). `allowSoften` gates the Soften button.
    function renderDefault(note, allowSoften) {
      sheet.innerHTML = '';

      var title = document.createElement('div');
      title.className = 'cbp-title';
      title.textContent = 'This dream can’t be generated';
      sheet.appendChild(title);

      if (note) {
        var noteEl = document.createElement('div');
        noteEl.className = 'cbp-note';
        noteEl.textContent = note;
        sheet.appendChild(noteEl);
      }

      var msg = document.createElement('div');
      msg.className = 'cbp-msg';
      msg.textContent = opts.message || 'That dream can’t be turned into a video.';
      sheet.appendChild(msg);

      var actions = document.createElement('div');
      actions.className = 'cbp-actions';

      if (allowSoften) {
        actions.appendChild(btn('Soften it for me', 'cbp-btn-primary', doSoften));
      }
      actions.appendChild(btn('Edit it myself', 'cbp-btn-secondary', function () {
        close();
        onApplyText(originalText);
      }));
      actions.appendChild(btn('Discard', 'cbp-btn-ghost', function () {
        close();
        onDiscard();
      }));

      sheet.appendChild(actions);
    }

    // The softening in-flight state — all controls disabled, spinner shown.
    function renderSoftening() {
      sheet.innerHTML = '';
      var title = document.createElement('div');
      title.className = 'cbp-title';
      title.innerHTML = '<span class="cbp-spin"></span>Softening your dream…';
      sheet.appendChild(title);
      var msg = document.createElement('div');
      msg.className = 'cbp-msg';
      msg.textContent = 'Rewriting it to keep the feeling without the explicit parts.';
      sheet.appendChild(msg);
    }

    function doSoften() {
      renderSoftening();
      fetch('/.netlify/functions/soften-dream-text', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: originalText })
      }).then(function (res) {
        return res.json().then(function (data) { return { ok: res.ok, data: data }; });
      }).then(function (r) {
        if (r.ok && r.data && r.data.allowed && r.data.softenedText) {
          // Passed the re-gate — hand the softened text to the editable
          // field for the user to review and generate (generation re-gates
          // server-side once more). Not a silent swap: the user sees the
          // new text in the field before generating.
          close();
          onApplyText(r.data.softenedText);
          return;
        }
        // Softened but STILL explicit (r.data.allowed === false), or the
        // request failed — either way, softening didn't get there. Re-show
        // the panel with a note and only Edit/Discard (no re-soften loop).
        var note = (r.ok && r.data && r.data.allowed === false)
          ? 'We couldn’t soften it enough — please edit it yourself.'
          : 'We couldn’t rewrite it just now — please edit it yourself.';
        renderDefault(note, false);
      }).catch(function () {
        renderDefault('We couldn’t rewrite it just now — please edit it yourself.', false);
      });
    }

    // Named-other-person block is never softenable — start without Soften.
    renderDefault(null, !namedPerson);
  }

  return { show: show, close: close };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = ContentBlockPanel;
}
