// js/report-sheet.js
//
// Report/block mini-sheet — tracker item
// for-product-public-feed-safety-in-app-re-ppuw77 (App Store Guideline 1.2
// / Google Play's equivalent UGC policy require in-app content reporting +
// user blocking for a public feed; independent of the store requirement, a
// public feed with real AI-generated content benefits from having this
// regardless). Opened from explore.html's feed-card "More" action (a
// third .feed-action alongside the existing Like/Share, only shown for a
// dream that isn't the viewer's own — see explore.html's cardHTML).
//
// Two options, deliberately minimal per that tracker item's own scope (no
// reason-picker taxonomy, no automated action on a report):
//   1. Report this dream  — expands into a one-field form (an OPTIONAL
//      short free-text reason) and POSTs to
//      netlify/functions/report-dream.js, which flags it into the
//      moderation queue (lib/moderation-store.js) for a human (the
//      founder) to read back later. No login required to file one — see
//      that endpoint's own header comment for why.
//   2. Block @handle       — hides that author's dreams from THIS
//      device's Explore feed going forward (js/store.js's
//      blockUser/getSharedFeed blockedByMe flag), and best-effort syncs
//      the block to a durable server-side store when signed in. DOES
//      require being signed in (there's no durable identity to hang a
//      block on otherwise) — a logged-out tap routes through the
//      caller's own signup nudge instead (see `onRequireLogin` below,
//      mirroring explore.html's existing nav-gate pattern for
//      +Create/Profile).
//
// Shared bottom-sheet plumbing (mount into #app, SheetDismiss.wire for
// tap-outside + drag-to-dismiss) follows the exact same pattern as
// js/share-sheet.js/js/purchase-sheet.js — see share-sheet.js's own header
// comment for why this codebase centralizes sheet behavior into one
// module rather than re-implementing it per page.
//
// Plain script (no ES modules — see CLAUDE.md), attaches
// window.ReportSheet.

(function () {
  'use strict';

  var SHEET_ID = 'report-sheet-overlay';
  var current = null; // the opts object passed to the most recent show() call

  // Per-instance-token guard against a stale async settlement (the report
  // submit fetch) mutating DOM that no longer belongs to the currently-open
  // sheet — this codebase's own documented recurring bug class (see
  // tracker.html's recurring-stale-async-callback-bug-shape-xp61pn), same
  // pattern js/share-sheet.js's currentGen/js/purchase-sheet.js's
  // currentGen/claimGen already use. Bumped on every show()/hide().
  var currentGen = 0;

  function trackLocal(name, props) {
    if (typeof window !== 'undefined' && window.posthog && typeof window.posthog.capture === 'function') {
      try { posthog.capture(name, props || {}); } catch (e) { /* analytics must never break the app */ }
    }
  }

  function ensureMounted() {
    if (document.getElementById(SHEET_ID)) return;
    var host = document.getElementById('app') || document.body;
    var wrap = document.createElement('div');
    wrap.id = SHEET_ID;
    wrap.className = 'sheet-overlay';
    wrap.innerHTML =
      '<div class="sheet report-sheet">' +
      '  <div class="sheet-handle"></div>' +
      '  <div id="report-sheet-menu">' +
      '    <div class="sheet-title">Report or block</div>' +
      '    <button type="button" class="share-sheet-option" id="report-opt-report">' +
      '      <span class="icon" id="report-opt-report-icon"></span>' +
      '      <span class="share-sheet-option-label">Report this dream</span>' +
      '    </button>' +
      '    <button type="button" class="share-sheet-option" id="report-opt-block">' +
      '      <span class="icon" id="report-opt-block-icon"></span>' +
      '      <span class="share-sheet-option-label" id="report-opt-block-label">Block user</span>' +
      '    </button>' +
      '  </div>' +
      '  <div id="report-sheet-form" style="display:none;">' +
      '    <div class="sheet-title">Report this dream</div>' +
      '    <textarea class="field" id="report-reason-input" maxlength="500" rows="3" dir="auto" placeholder="What\'s wrong with this? (optional)" style="min-height:80px;"></textarea>' +
      '    <div class="err-text" id="report-sheet-error"></div>' +
      '    <button type="button" class="btn btn-primary btn-block" id="report-submit-btn">Submit report</button>' +
      '    <span class="link-text" id="report-form-back" style="display:block; text-align:center; margin-top:10px; cursor:pointer;">Back</span>' +
      '  </div>' +
      '  <div id="report-sheet-done" style="display:none; text-align:center;">' +
      '    <div class="sheet-title">Thanks — reported</div>' +
      '    <div style="font-size:13.5px; color:var(--text-muted); line-height:1.5; margin-bottom:16px;">Our team will take a look. This dream stays visible to others while we review it.</div>' +
      '    <button type="button" class="btn btn-secondary btn-block" id="report-done-close-btn">Close</button>' +
      '  </div>' +
      '</div>';
    host.appendChild(wrap);

    // Tap-outside + drag-to-dismiss — same shared wiring every other
    // .sheet-overlay in this app uses (js/sheet-dismiss.js).
    SheetDismiss.wire(wrap, hide);

    if (typeof Icons !== 'undefined') {
      document.getElementById('report-opt-report-icon').innerHTML = Icons.flag;
      document.getElementById('report-opt-block-icon').innerHTML = Icons.userX;
    }

    document.getElementById('report-opt-report').addEventListener('click', showReportForm);
    document.getElementById('report-opt-block').addEventListener('click', chooseBlock);
    document.getElementById('report-submit-btn').addEventListener('click', submitReport);
    document.getElementById('report-form-back').addEventListener('click', function () { showView('report-sheet-menu'); });
    document.getElementById('report-done-close-btn').addEventListener('click', hide);
  }

  function showView(id) {
    ['report-sheet-menu', 'report-sheet-form', 'report-sheet-done'].forEach(function (v) {
      document.getElementById(v).style.display = v === id ? 'block' : 'none';
    });
  }

  function resetSubmitButton() {
    var btn = document.getElementById('report-submit-btn');
    btn.disabled = false;
    btn.textContent = 'Submit report';
  }

  /**
   * opts:
   *   dream         — the dream record being reported/its author blocked
   *                   ({ id, ownerHandle, caption, ... } — exactly what
   *                   explore.html's own in-memory feed entries look like).
   *   isLoggedIn    — whether Block should actually proceed (see header
   *                   comment) or route through onRequireLogin instead.
   *   onBlocked(handle) — called immediately after a successful local
   *                   block, so the caller can drop that author's other
   *                   dreams out of its own currently-rendered list.
   *   onRequireLogin() — called instead of blocking when !isLoggedIn.
   *   onToast(msg)  — optional, the caller's own showToast.
   */
  function show(opts) {
    opts = opts || {};
    ensureMounted();
    current = opts;
    currentGen++;
    document.getElementById('report-reason-input').value = '';
    document.getElementById('report-sheet-error').textContent = '';
    document.getElementById('report-opt-block-label').textContent = 'Block ' + (DreamStore.displayHandle(opts.dream && opts.dream.ownerHandle) || 'user');
    resetSubmitButton();
    showView('report-sheet-menu');
    document.getElementById(SHEET_ID).classList.add('open');
  }

  function hide() {
    var el = document.getElementById(SHEET_ID);
    if (el) el.classList.remove('open');
    current = null;
    currentGen++;
  }

  function showReportForm() {
    if (!current) return;
    document.getElementById('report-sheet-error').textContent = '';
    showView('report-sheet-form');
  }

  function submitReport() {
    if (!current) return;
    var dream = current.dream || {};
    var reason = document.getElementById('report-reason-input').value.trim();
    var btn = document.getElementById('report-submit-btn');
    btn.disabled = true;
    btn.textContent = 'Submitting…';
    document.getElementById('report-sheet-error').textContent = '';

    var myGen = currentGen;
    fetch('/.netlify/functions/report-dream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        dreamId: dream.id,
        dreamOwnerHandle: dream.ownerHandle || null,
        dreamCaption: dream.caption || null,
        reporterHandle: (window.DreamStore && DreamStore.getCurrentUser()) ? DreamStore.getCurrentUser().handle : null,
        reason: reason || null
      })
    }).then(function (res) {
      return res.json().then(function (data) { return { ok: res.ok, data: data }; });
    }).then(function (result) {
      if (myGen !== currentGen) return; // sheet dismissed/reopened for a different dream meanwhile -- this attempt is abandoned, no-op
      if (!result.ok) throw new Error((result.data && result.data.error) || 'report_failed');
      trackLocal('dream_reported', { dreamId: dream.id });
      showView('report-sheet-done');
    }).catch(function () {
      if (myGen !== currentGen) return; // abandoned attempt -- don't surface an error for a sheet the user already left
      resetSubmitButton();
      document.getElementById('report-sheet-error').textContent = "Couldn't submit your report — try again.";
    });
  }

  function chooseBlock() {
    if (!current) return;
    var opts = current; // capture before hide() clears `current`
    var dream = opts.dream || {};
    var handle = dream.ownerHandle;

    if (!opts.isLoggedIn) {
      hide();
      if (typeof opts.onRequireLogin === 'function') opts.onRequireLogin();
      return;
    }

    hide();
    trackLocal('user_blocked', { blockedHandle: handle });
    if (window.DreamStore && typeof DreamStore.blockUser === 'function') {
      DreamStore.blockUser(handle);
    }
    if (typeof opts.onBlocked === 'function') opts.onBlocked(handle);
    if (typeof opts.onToast === 'function') opts.onToast("Blocked " + DreamStore.displayHandle(handle) + " — you won't see their dreams anymore");
  }

  var ReportSheet = { show: show, hide: hide };

  if (typeof window !== 'undefined') window.ReportSheet = ReportSheet;
  if (typeof module !== 'undefined' && module.exports) module.exports = ReportSheet;
})();
