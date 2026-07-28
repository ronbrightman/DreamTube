// js/share-sheet.js
//
// Share mini-sheet — tracker item
// for-product-build-share-mini-sheet-share-r42tc4 (founder-reviewed
// 2026-07-28, mock: share-save-sheet). Replaces the old single-tap Share
// button (result.html's topbar share-btn, explore.html's feed-card
// [data-share] action) with a small bottom sheet offering two options:
//
//   1. Share link  — EXACTLY the pre-existing navigator.share/clipboard-
//      copy/unsupported-toast behavior both call sites already had,
//      unchanged, except the URL now points at the new
//      netlify/functions/share-dream.js endpoint instead of a bare
//      explore.html?id=... link, so a pasted link finally carries a real
//      og: preview card (see that file's own header comment for the
//      "why" — PART B of this same tracker item).
//   2. Save to device — new: fetches the dream's own media file
//      (videoUrl/imageUrl) as a blob and hands it to the OS as a real
//      FILE via navigator.share({files:[...]}) when
//      navigator.canShare({files:[...]}) says the browser supports it
//      (surfaces the native "Save Video"/"Save Image" option — the whole
//      point, a real file share rather than a link). Falls back to a
//      plain <a download> object-URL, or a new-tab open of the raw media
//      URL if even fetching the media as a blob fails (e.g. a CORS-
//      blocked external fal.ai image URL) — Save must never do nothing.
//
// Both call sites' own publish-gating (result.html's "share an
// unpublished dream" warning modal) and dream-lookup are UNCHANGED and
// stay entirely on the calling page — this module only ever receives an
// already-resolved `dream` object once the caller has decided sharing
// may proceed. explore.html's feed cards need no such gate at all (the
// shared feed only ever lists already-published dreams).
//
// Shared bottom-sheet plumbing (mount into #app, SheetDismiss.wire for
// tap-outside + drag-to-dismiss) follows the exact same pattern as
// js/purchase-sheet.js's out-of-tokens sheet — see that file's own
// header comment for why this codebase centralizes sheet behavior into
// one module rather than re-implementing it per page.
//
// Plain script (no ES modules — see CLAUDE.md), attaches
// window.ShareSheet.

(function () {
  'use strict';

  var SHEET_ID = 'share-sheet-overlay';
  var current = null; // the opts object passed to the most recent show() call

  // Per-instance-token guard against a stale async settlement (the
  // "Save to device" fetch) mutating DOM that no longer belongs to the
  // currently-open sheet — this codebase's own documented recurring bug
  // class (see tracker.html's recurring-stale-async-callback-bug-shape-
  // xp61pn), same pattern already used by js/purchase-sheet.js's
  // currentGen/claimGen. Bumped on every show()/hide().
  var currentGen = 0;

  function trackLocal(name, props) {
    if (typeof window !== 'undefined' && window.posthog && typeof window.posthog.capture === 'function') {
      try { posthog.capture(name, props || {}); } catch (e) { /* analytics must never break the app */ }
    }
  }

  /** The new per-dream link-preview endpoint's URL (netlify/functions/share-dream.js) — replaces the bare explore.html?id=... link Share used to build directly. */
  function shareEndpointUrl(dreamId) {
    return location.origin + '/.netlify/functions/share-dream?id=' + encodeURIComponent(dreamId);
  }

  function ensureMounted() {
    if (document.getElementById(SHEET_ID)) return;
    var host = document.getElementById('app') || document.body;
    var wrap = document.createElement('div');
    wrap.id = SHEET_ID;
    wrap.className = 'sheet-overlay';
    wrap.innerHTML =
      '<div class="sheet share-sheet">' +
      '  <div class="sheet-handle"></div>' +
      '  <div class="sheet-title">Share</div>' +
      '  <button type="button" class="share-sheet-option" id="share-opt-link">' +
      '    <span class="icon" id="share-opt-link-icon"></span>' +
      '    <span class="share-sheet-option-label">Share link</span>' +
      '  </button>' +
      '  <button type="button" class="share-sheet-option" id="share-opt-save">' +
      '    <span class="icon" id="share-opt-save-icon"></span>' +
      '    <span class="share-sheet-option-label" id="share-opt-save-label">Save to device</span>' +
      '  </button>' +
      '  <div class="share-sheet-error" id="share-sheet-error" style="display:none;"></div>' +
      '</div>';
    host.appendChild(wrap);

    // Tap-outside + drag-to-dismiss — same shared wiring every other
    // .sheet-overlay in this app uses (js/sheet-dismiss.js).
    SheetDismiss.wire(wrap, hide);

    if (typeof Icons !== 'undefined') {
      document.getElementById('share-opt-link-icon').innerHTML = Icons.shareIos;
      document.getElementById('share-opt-save-icon').innerHTML = Icons.download;
    }

    document.getElementById('share-opt-link').addEventListener('click', function () { chooseLink(); });
    document.getElementById('share-opt-save').addEventListener('click', function () { chooseSave(); });
  }

  function showError(msg) {
    var el = document.getElementById('share-sheet-error');
    el.textContent = msg;
    el.style.display = 'block';
  }

  function resetSaveOption() {
    var btn = document.getElementById('share-opt-save');
    var label = document.getElementById('share-opt-save-label');
    btn.disabled = false;
    label.textContent = 'Save to device';
  }

  /**
   * opts:
   *   dream     — the resolved dream record { id, caption, videoUrl,
   *               imageUrl, mediaType }. Caller's job to have already
   *               resolved/gated this (publish-first modal, etc).
   *   shareText — the exact share text this call site used before
   *               (result.html/explore.html word this slightly
   *               differently — "my dream" vs "this dream" — preserved
   *               verbatim by passing it in rather than this module
   *               guessing a perspective).
   *   onToast   — optional function(msg) — the caller's own showToast,
   *               used for the clipboard-copy-fallback/unsupported
   *               messages the old inline doShare() already showed.
   */
  function show(opts) {
    opts = opts || {};
    ensureMounted();
    current = opts;
    currentGen++;
    document.getElementById('share-sheet-error').style.display = 'none';
    resetSaveOption();
    document.getElementById(SHEET_ID).classList.add('open');
  }

  function hide() {
    var el = document.getElementById(SHEET_ID);
    if (el) el.classList.remove('open');
    current = null;
    currentGen++;
  }

  // ==========================================================================
  // Option 1 — Share link. EXACTLY the pre-existing navigator.share /
  // clipboard-copy / unsupported-toast logic both call sites had before
  // this feature, just centralized here and pointed at share-dream.js's
  // URL instead of a bare explore.html?id=... link.
  // ==========================================================================
  function chooseLink() {
    if (!current) return;
    var dream = current.dream;
    var onToast = current.onToast;
    var shareText = current.shareText || ('Check out this dream on DreamTube!');
    trackLocal('share_option_chosen', { option: 'link' });
    hide();

    var shareUrl = shareEndpointUrl(dream.id);
    if (navigator.share) {
      navigator.share({ title: 'DreamTube', text: shareText, url: shareUrl }).catch(function () { /* user cancelled the share sheet */ });
    } else if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(shareUrl).then(function () {
        if (typeof onToast === 'function') onToast('Link copied to clipboard');
      }).catch(function () {
        if (typeof onToast === 'function') onToast("Couldn't copy link");
      });
    } else {
      if (typeof onToast === 'function') onToast("Sharing isn't supported in this browser");
    }
  }

  // ==========================================================================
  // Option 2 — Save to device (new).
  // ==========================================================================

  /** Best-guess file extension off a blob's MIME type, falling back to a sane default for the media type when the MIME is missing/unrecognized (some fetch responses omit Content-Type). */
  function extensionFromMime(mime, fallback) {
    if (!mime) return fallback;
    if (mime.indexOf('mp4') !== -1) return 'mp4';
    if (mime.indexOf('webm') !== -1) return 'webm';
    if (mime.indexOf('quicktime') !== -1) return 'mov';
    if (mime.indexOf('png') !== -1) return 'png';
    if (mime.indexOf('webp') !== -1) return 'webp';
    if (mime.indexOf('gif') !== -1) return 'gif';
    if (mime.indexOf('jpeg') !== -1 || mime.indexOf('jpg') !== -1) return 'jpg';
    return fallback;
  }

  function fetchAsBlob(url) {
    return fetch(url).then(function (res) {
      if (!res.ok) throw new Error('media_fetch_failed');
      return res.blob();
    });
  }

  /** Plain <a download> object-URL trigger — the fallback when a File was successfully fetched but the browser's navigator.canShare({files}) declined it. */
  function downloadBlob(blob, filename) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
  }

  function chooseSave() {
    if (!current) return;
    var dream = current.dream;
    trackLocal('share_option_chosen', { option: 'save' });

    // Derived off which URL is actually being used, not dream.mediaType --
    // a dream can carry both fields (e.g. after "Turn this into a video"),
    // and videoUrl always wins when present (same precedence result.html's
    // own player already uses), so the extension/MIME fallback below must
    // match the URL this function is actually about to fetch, not a
    // possibly-stale/absent mediaType label.
    var usingVideo = !!dream.videoUrl;
    var mediaUrl = dream.videoUrl || dream.imageUrl;
    var mediaType = usingVideo ? 'video' : 'image';
    if (!mediaUrl) {
      showError("This dream doesn't have a saved file yet");
      return;
    }

    var myGen = currentGen;

    // No File-based share support at all (most desktop browsers) — skip
    // straight to opening the raw media URL in a new tab. No point
    // fetching a blob just to build an <a download> when a plain new-tab
    // open (browser's own image/video context menu / built-in save UI)
    // achieves the same "get me this file" outcome with far less latency.
    if (!(navigator.canShare && navigator.share)) {
      hide();
      window.open(mediaUrl, '_blank');
      return;
    }

    var btn = document.getElementById('share-opt-save');
    var label = document.getElementById('share-opt-save-label');
    btn.disabled = true;
    label.textContent = 'Preparing…';
    document.getElementById('share-sheet-error').style.display = 'none';

    fetchAsBlob(mediaUrl).then(function (blob) {
      if (myGen !== currentGen) return; // sheet dismissed/reopened meanwhile -- this attempt is abandoned, no-op
      var ext = extensionFromMime(blob.type, mediaType === 'image' ? 'jpg' : 'mp4');
      var filename = 'dreamtube-' + (dream.id || 'dream') + '.' + ext;
      var fallbackMime = mediaType === 'image' ? 'image/jpeg' : 'video/mp4';
      var file = new File([blob], filename, { type: blob.type || fallbackMime });

      if (navigator.canShare({ files: [file] })) {
        hide();
        navigator.share({ files: [file] }).catch(function () { /* user cancelled the native share sheet */ });
      } else {
        downloadBlob(blob, filename);
        hide();
      }
    }).catch(function () {
      if (myGen !== currentGen) return; // abandoned attempt -- don't surprise-open a tab for a sheet the user already left
      // Fetching the media as a blob failed (CORS on an external fal.ai
      // image URL, a network hiccup, etc) — Save must never just do
      // nothing. Opening the raw media URL in a new tab still lets the
      // user save it manually via their browser's own context menu.
      hide();
      window.open(mediaUrl, '_blank');
    });
  }

  var ShareSheet = { show: show, hide: hide };

  if (typeof window !== 'undefined') window.ShareSheet = ShareSheet;
  if (typeof module !== 'undefined' && module.exports) module.exports = ShareSheet;
})();
