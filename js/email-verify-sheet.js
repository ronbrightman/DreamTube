// js/email-verify-sheet.js
//
// Deferred email-verification sheet (tracker item for-product-build-
// passwordless-signup-fo-at2fko) — the explicit "type the code back in"
// UI moment for a passwordless account, shown at a LATER, natural point,
// never at signup itself (the founder's own instruction: "never blocking
// the first-session dream reveal"). Any click on the link in the
// verification email marks the account verified WITHOUT ever needing this
// sheet at all (see verify-email-link.js) — this only matters for someone
// who comes back without having clicked that link.
//
// TRIGGER SCOPE, THIS BUILD (documented deliberate scope — see this
// tracker item's own "pick a sensible scope, don't wire every trigger"
// allowance): wired for the "next visit" trigger only (home.html, on a
// FRESH page load — see maybeShowOnNextVisit's own doc comment for how
// "fresh" is distinguished from the same-tab landing right after signup).
// "Before publish" and "before purchase" are NOT wired to open this sheet
// interactively in this pass — both are still enforced server-side
// (publish-dream.js/create-checkout-session-dodo.js reject an unverified
// account's attempt — see account-store.js's GATE LIST comment), but
// neither call site here shows this sheet in reaction to that rejection
// yet: publish is a fire-and-forget background sync with no error surface
// today (see js/store.js's syncPublishedDreamToFeed doc comment), and
// wiring a purchase-time interactive prompt is a real, separate follow-up
// left for a later pass rather than force-fit into this one.
//
// Shared bottom-sheet plumbing, same pattern as js/report-sheet.js/js/
// share-sheet.js/js/purchase-sheet.js — see report-sheet.js's own header
// comment for why this codebase centralizes sheet behavior into one
// module rather than re-implementing it per page.
//
// Plain script (no ES modules — see CLAUDE.md), attaches
// window.EmailVerifySheet.

(function () {
  'use strict';

  var SHEET_ID = 'email-verify-sheet-overlay';
  // Same per-instance-token guard against a stale async settlement
  // mutating DOM for a sheet that's since been dismissed/reopened — see
  // js/report-sheet.js's own identical currentGen doc comment (this
  // codebase's documented recurring bug class, tracker.html's
  // recurring-stale-async-callback-bug-shape-xp61pn).
  var currentGen = 0;

  // sessionStorage marker so this sheet is offered AT MOST once per tab
  // session even across several page loads within that same visit (e.g.
  // dismissed on home.html, then navigating to explore.html and back
  // shouldn't re-open it) — cleared naturally when the tab/window closes,
  // which is exactly "the next real visit" this feature's trigger is
  // scoped to. A real verification (code or link) also stops future
  // prompts permanently via the account's own emailVerified flag, no
  // sessionStorage needed for that half.
  var SHOWN_THIS_SESSION_KEY = 'dreamtube_email_verify_sheet_shown';

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
      '<div class="sheet email-verify-sheet">' +
      '  <div class="sheet-handle"></div>' +
      '  <div id="email-verify-sheet-form">' +
      '    <div class="sheet-title">Verify your email</div>' +
      '    <div style="font-size:13.5px; color:var(--text-muted); line-height:1.5; margin-bottom:16px;" id="email-verify-sheet-copy"></div>' +
      '    <input class="field" id="email-verify-code-input" type="text" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="6-digit code" style="text-align:center; letter-spacing:6px; font-size:20px;">' +
      '    <div class="err-text" id="email-verify-sheet-error"></div>' +
      '    <button type="button" class="btn btn-primary btn-block" id="email-verify-submit-btn" style="margin-top:10px;">Verify</button>' +
      '    <span class="link-text" id="email-verify-resend-link" style="display:block; text-align:center; margin-top:14px; cursor:pointer;">Resend code</span>' +
      '    <span class="link-text" id="email-verify-later-link" style="display:block; text-align:center; margin-top:8px; cursor:pointer; opacity:.7;">Not now</span>' +
      '  </div>' +
      '  <div id="email-verify-sheet-done" style="display:none; text-align:center;">' +
      '    <div class="sheet-title">You\'re verified</div>' +
      '    <div style="font-size:13.5px; color:var(--text-muted); line-height:1.5; margin-bottom:16px;">Thanks — your email is confirmed.</div>' +
      '    <button type="button" class="btn btn-secondary btn-block" id="email-verify-done-close-btn">Close</button>' +
      '  </div>' +
      '</div>';
    host.appendChild(wrap);

    SheetDismiss.wire(wrap, hide);

    document.getElementById('email-verify-submit-btn').addEventListener('click', submitCode);
    document.getElementById('email-verify-resend-link').addEventListener('click', resendCode);
    document.getElementById('email-verify-later-link').addEventListener('click', function () {
      trackLocal('email_verify_sheet_dismissed');
      hide();
    });
    document.getElementById('email-verify-done-close-btn').addEventListener('click', hide);
    document.getElementById('email-verify-code-input').addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter') { ev.preventDefault(); submitCode(); }
    });
  }

  function resetForm() {
    document.getElementById('email-verify-code-input').value = '';
    document.getElementById('email-verify-sheet-error').textContent = '';
    var email = (window.DreamStore && DreamStore.getAccountEmail && DreamStore.getAccountEmail()) || 'your email';
    document.getElementById('email-verify-sheet-copy').textContent =
      'We sent a 6-digit code to ' + email + '. Enter it below, or just tap the link in that email — either one works.';
    var btn = document.getElementById('email-verify-submit-btn');
    btn.disabled = false;
    btn.textContent = 'Verify';
    document.getElementById('email-verify-sheet-form').style.display = 'block';
    document.getElementById('email-verify-sheet-done').style.display = 'none';
  }

  // Opening the sheet must actually SEND a code (founder repro 2026-08-07:
  // he was shown "We sent a 6-digit code" post-purchase and no email ever
  // came — the only automatic send was at signup time, possibly days
  // earlier or never, and the sheet's copy simply lied). One auto-send per
  // page load: re-opens in the same page reuse the same still-valid code
  // (the manual Resend link covers a genuinely lost email), so the server's
  // per-IP daily cap isn't burned by sheet-open churn.
  var autoSentThisLoad = false;
  function autoSendOnOpen() {
    if (autoSentThisLoad) return;
    autoSentThisLoad = true;
    if (!window.DreamStore || typeof DreamStore.resendVerificationCode !== 'function') return;
    DreamStore.resendVerificationCode().then(function (result) {
      trackLocal('email_verify_auto_send', { ok: !!(result && result.ok) });
    }).catch(function () { /* the Resend link remains the manual fallback */ });
  }

  /** opts.source — free-text, purely for analytics (e.g. 'next_visit') — which trigger opened this sheet. */
  function show(opts) {
    opts = opts || {};
    ensureMounted();
    currentGen++;
    resetForm();
    autoSendOnOpen();
    document.getElementById(SHEET_ID).classList.add('open');
    trackLocal('email_verify_sheet_shown', { source: opts.source || null });
    document.getElementById('email-verify-code-input').focus();
  }

  function hide() {
    var el = document.getElementById(SHEET_ID);
    if (el) el.classList.remove('open');
    currentGen++;
  }

  function submitCode() {
    var input = document.getElementById('email-verify-code-input');
    var code = (input.value || '').trim();
    var errEl = document.getElementById('email-verify-sheet-error');
    errEl.textContent = '';
    if (!/^[0-9]{6}$/.test(code)) {
      errEl.textContent = 'Enter the 6-digit code from your email.';
      return;
    }
    var btn = document.getElementById('email-verify-submit-btn');
    btn.disabled = true;
    btn.textContent = 'Verifying…';

    var myGen = currentGen;
    DreamStore.verifyEmailCode(code).then(function (result) {
      if (myGen !== currentGen) return; // sheet dismissed/reopened meanwhile
      if (!result.ok) {
        btn.disabled = false;
        btn.textContent = 'Verify';
        errEl.textContent = result.error || "That code didn't match — try again.";
        return;
      }
      trackLocal('email_verified', { method: 'code' });
      document.getElementById('email-verify-sheet-form').style.display = 'none';
      document.getElementById('email-verify-sheet-done').style.display = 'block';
    });
  }

  function resendCode() {
    var link = document.getElementById('email-verify-resend-link');
    var original = link.textContent;
    link.textContent = 'Sending…';
    var myGen = currentGen;
    DreamStore.resendVerificationCode().then(function (result) {
      if (myGen !== currentGen) return;
      link.textContent = result.ok ? 'Sent — check your email' : (result.error || original);
      setTimeout(function () {
        if (myGen === currentGen) link.textContent = original;
      }, 4000);
    });
  }

  /**
   * The "next visit" trigger (see this file's own header comment for
   * scope) — call once per page, after the page's own login gate has
   * already confirmed a signed-in user. No-ops entirely (never shows,
   * never even mounts the sheet's DOM) unless ALL of:
   *   - a real account is signed in
   *   - DreamStore.getAccountEmailVerified() is false
   *   - this sessionStorage tab session hasn't already been offered it
   *     (see SHOWN_THIS_SESSION_KEY's own doc comment — this is what
   *     distinguishes "the SAME tab landing on home.html right after
   *     completing signup" — which must never interrupt the first-session
   *     dream reveal — from "a later visit", since a closed/reopened tab
   *     or browser gets a fresh sessionStorage with no marker at all).
   * start.html's own passwordless signup arm sets this SAME marker at the
   * moment it completes signup (see that file's own comment) specifically
   * so THIS tab's own immediate landing is already "marked shown" without
   * ever actually showing anything — the next fresh visit is what clears
   * it.
   */
  function maybeShowOnNextVisit() {
    if (!window.DreamStore || typeof DreamStore.getCurrentUser !== 'function') return;
    if (!DreamStore.getCurrentUser()) return;
    if (DreamStore.getAccountEmailVerified()) return;
    try {
      if (sessionStorage.getItem(SHOWN_THIS_SESSION_KEY)) return;
      sessionStorage.setItem(SHOWN_THIS_SESSION_KEY, '1');
    } catch (e) {
      // sessionStorage unavailable (e.g. private mode) — fall through and
      // show anyway rather than silently never offering verification at
      // all for a browser that can't persist the "already shown" marker.
    }
    show({ source: 'next_visit' });
  }

  var EmailVerifySheet = { show: show, hide: hide, maybeShowOnNextVisit: maybeShowOnNextVisit };

  if (typeof window !== 'undefined') window.EmailVerifySheet = EmailVerifySheet;
  if (typeof module !== 'undefined' && module.exports) module.exports = EmailVerifySheet;
})();
