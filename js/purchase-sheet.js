// js/purchase-sheet.js
//
// Shared "out of tokens" purchase sheet — tracker item
// for-product-build-out-of-tokens-purchase-2y8hyw (founder directive,
// 2026-07-26: "the store must come up whenever a user tries any action
// without enough tokens"). Replaces the old per-page #modal-quota
// ("Out of tokens for now" / plain "Token shop" link, no arithmetic, no
// one-tap purchase, no return path) on style.html, result.html (both the
// Edit sheet's "Generate Again" AND the "Turn this into a video" upsell),
// and processing.html's E112/E412 fail path.
//
// Design mock (founder-approved 2026-07-26): docs/design/out-of-tokens-sheet.html,
// branch claude/manager-onboarding-xcq4ul. Behavior is locked — only
// minor visual tweaks may follow.
//
// Plain script (no ES modules — matches every other file in this
// codebase, see CLAUDE.md), attaches window.PurchaseSheet. Pure (no-DOM)
// helpers are dual-exported via module.exports too (same guarded pattern
// as js/wizard-chips.js) so test/*.test.js can require() this file
// directly for node --test coverage of the arithmetic/pack-selection
// logic, without needing a real browser for that part.
//
// ============================================================================
// THE CORE BUG THIS FIXES (internal audit, same tracker item)
// ----------------------------------------------------------------------------
// style.html only ever called DreamStore.setDraft({style, mediaType,
// sourceImageUrl}) inside proceedToGenerate() — which was SKIPPED
// entirely whenever generation was blocked by insufficient tokens (the
// old code checked tokensBlockGeneration() and opened the modal WITHOUT
// ever calling proceedToGenerate/setDraft first). result.html never
// persisted the edit sheet's caption/style, or turnImageIntoVideo's own
// draft, before showing its own copy of the same modal, for the
// identical reason — and its old modal didn't even offer a real
// return-path purchase anyway. So a user who hit the old modal, bought
// tokens on shop.html, and came back had NO intact draft to resume from.
//
// show() below is the single choke point every blocked-action call site
// now routes through, and it calls the caller's persistDraft() — the
// FULL blocked action's state — BEFORE the sheet is ever shown, not just
// before the buy button. This must happen even if the user ends up
// dismissing the sheet or tapping "See all packs" instead of buying
// right now, since they may still come back later via the balance chip
// and expect their in-progress edit to still be there.
//
// processing.html needs no equivalent draft-persistence fix — see its
// own E112/E412 handling: by the time generate-video.js/generate-image.js
// can even return E112/E412, submission already required a complete
// draft, so it's already intact. That's the reference shape "correctly
// preserved" state looks like.
// ============================================================================

(function () {
  'use strict';

  // ==========================================================================
  // Pure logic (no DOM) — token packs, arithmetic, countdown formatting.
  // Mirrors shop.html's own PACK_INFO (Token Economy C, founder-approved
  // 2026-07-26 night: 100/$2.99, 300/$7.99, 700/$14.99). Kept as its own
  // copy rather than a shared import (this codebase has no bundler/require
  // for browser code — see js/store.js's header comment) — same "one small
  // local map, not a shared module" convention shop.html's own PACK_INFO
  // comment already documents.
  // ==========================================================================
  var PACK_INFO = {
    pack100: { tokens: 100, price: 2.99 },
    pack300: { tokens: 300, price: 7.99 },
    pack700: { tokens: 700, price: 14.99 }
  };
  var PACK_ORDER = ['pack100', 'pack300', 'pack700'];

  /**
   * The "one-tap purchase of the smallest sufficient pack" logic: the
   * cheapest pack whose token amount alone covers the shortfall. In
   * practice, since every generation costs at most 100 tokens (video) or
   * 10 (image) and balance is never negative, `neededTokens` never
   * exceeds 100 — so pack100 (100 tokens) is always sufficient today.
   * Written generally (not hardcoded to pack100) so this stays correct if
   * a future, larger-cost action is ever added without anyone having to
   * remember to revisit this specific function.
   */
  function pickSmallestSufficientPack(neededTokensAmount) {
    for (var i = 0; i < PACK_ORDER.length; i++) {
      var key = PACK_ORDER[i];
      if (PACK_INFO[key].tokens >= neededTokensAmount) return key;
    }
    return PACK_ORDER[PACK_ORDER.length - 1]; // largest pack — best available, even if not technically "sufficient"
  }

  /** How many more tokens are needed to cover `cost` from `balance` — never negative. */
  function neededTokens(balance, cost) {
    var b = typeof balance === 'number' && !isNaN(balance) ? balance : 0;
    var c = typeof cost === 'number' && !isNaN(cost) ? cost : 0;
    return Math.max(c - b, 0);
  }

  /** "3h 12m" / "42m" / "now" from an epoch-ms nextClaimAt — same shape as profile.html/style.html/result.html/processing.html/shop.html's own copies of this (no shared JS module for it pre-dating this file — see js/store.js's header comment on why not). */
  function formatTokenCountdown(nextClaimAt) {
    if (nextClaimAt == null) return '';
    var ms = nextClaimAt - Date.now();
    if (ms <= 0) return 'now';
    var totalMin = Math.ceil(ms / 60000);
    var h = Math.floor(totalMin / 60);
    var m = totalMin % 60;
    return h > 0 ? (h + 'h ' + m + 'm') : (m + 'm');
  }

  /**
   * The sheet's "escape line" — the daily-CLAIM line, kept honest and
   * visible per the founder's spec ("never hide it"). Reads `claimable`/
   * `nextClaimAt` live off tokenStatus (lib/entitlements.js's
   * getTokenStatus) — 2026-07-28 daily-claim switch: this used to be a
   * passive countdown to an automatic grant ("Or wait — N free tokens in
   * Xh Ym" / a "paused — at the max" ceiling state); the ceiling is gone
   * entirely (see entitlements.js's own doc block) and the daily tokens are
   * no longer automatic at all — flipped to claim-framing so this line
   * never promises something the app doesn't actually do. When claimable
   * right now, this text alone doesn't grant anything — the actual claim
   * only happens through the claim sheet/chip/inline "Claim +N" button
   * (see showClaimSheet below), never as a side effect of this sheet being
   * open.
   */
  function waitLineText(tokenStatus) {
    if (!tokenStatus) return '';
    var amount = tokenStatus.dailyClaimAmount != null ? tokenStatus.dailyClaimAmount : 20;
    if (tokenStatus.claimable) {
      return 'Or claim ' + amount + ' free tokens above';
    }
    if (tokenStatus.nextClaimAt) {
      return 'Or claim ' + amount + ' free tokens in ' + formatTokenCountdown(tokenStatus.nextClaimAt);
    }
    return '';
  }

  // ==========================================================================
  // DOM: the sheet itself
  // ==========================================================================
  var SHEET_ID = 'purchase-sheet-overlay';
  var current = null; // the opts object passed to the most recent show() call

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
      '<div class="sheet purchase-sheet">' +
      '  <div class="sheet-handle"></div>' +
      '  <div class="purchase-sheet-title" id="ps-title"></div>' +
      '  <div class="purchase-sheet-body" id="ps-body"></div>' +
      // Daily-claim option (tracker item for-product-build-the-daily-token-
      // claim--fngrwd, item 5): "instantly unblocks an image" when the
      // account has an unclaimed +20 waiting — shown ABOVE the buy CTA,
      // hidden entirely (display:none, see renderClaimOption below) unless
      // tokenStatus.claimable is true for THIS show() call.
      '  <button type="button" class="claim-inline-btn" id="ps-claim-btn" style="display:none;"><span id="ps-claim-label"></span></button>' +
      '  <div class="purchase-meter"><i id="ps-meter-fill"></i></div>' +
      '  <div class="purchase-meter-label"><span id="ps-meter-have"></span><span id="ps-meter-need"></span></div>' +
      '  <button type="button" class="purchase-buy-btn" id="ps-buy-btn"><span id="ps-buy-label"></span></button>' +
      '  <div class="purchase-error" id="ps-error" style="display:none;"></div>' +
      '  <div class="purchase-see-all" id="ps-see-all">See all packs →</div>' +
      '  <div class="purchase-wait-line" id="ps-wait-line"></div>' +
      '  <div class="purchase-trust">Secure checkout via Dodo — one-time, no subscription</div>' +
      '</div>';
    host.appendChild(wrap);

    // Tap-outside-to-dismiss — same behavior as every other .sheet-overlay
    // in this app (result.html's edit/character/interp sheets).
    wrap.addEventListener('click', function (e) {
      if (e.target === wrap) hide();
    });
    document.getElementById('ps-see-all').addEventListener('click', function () {
      if (current) trackLocal('out_of_tokens_choice', { source: current.source || null, choice: 'see_all_packs' });
      location.href = 'shop.html?source=blocked_action';
    });
    document.getElementById('ps-claim-btn').addEventListener('click', function () { claimInline(); });
  }

  var CLAIM_INLINE_IDLE_LABEL_PREFIX = 'Claim +';

  /** Shows/hides + (re)labels the inline "Claim +N" button per the CURRENT `current.tokenStatus.claimable` — called from show() and again after a successful inline claim (which flips claimable false for the rest of this sheet's lifetime). */
  function renderClaimOption() {
    var btn = document.getElementById('ps-claim-btn');
    var label = document.getElementById('ps-claim-label');
    var status = current && current.tokenStatus;
    if (!status || !status.claimable) {
      btn.style.display = 'none';
      return;
    }
    var amount = status.dailyClaimAmount != null ? status.dailyClaimAmount : 20;
    label.textContent = CLAIM_INLINE_IDLE_LABEL_PREFIX + amount + ' free tokens';
    btn.style.display = '';
    btn.disabled = false;
  }

  /**
   * The out-of-tokens sheet's inline claim affordance — same server call as
   * the dedicated claim sheet (DreamStore.claimDailyTokens, see
   * js/store.js), but rendered inline (no nested sheet) since this sheet is
   * already open for a different, more urgent reason (a blocked action).
   * On a genuine claim, updates the balance shown in THIS sheet (title/
   * body/meter) live off the new balance so a user whose claim now covers
   * `cost` (e.g. the 10-token image case the founder's own proposal called
   * out) sees it reflected immediately, then hides the claim button (an
   * account can only claim once per cooldown). `daily_claim_completed`
   * fires ONLY here, on the real server-confirmed response — never
   * optimistically.
   */
  function claimInline() {
    if (!current) return;
    var btn = document.getElementById('ps-claim-btn');
    var label = document.getElementById('ps-claim-label');
    btn.disabled = true;
    label.textContent = 'Claiming…';
    DreamStore.claimDailyTokens().then(function (data) {
      if (!data || !data.claimed) {
        // Lost a race (another tab/request claimed first) or the cooldown
        // hadn't actually elapsed — not an error, just nothing to reflect.
        // The button simply disappears since there's genuinely nothing left
        // to claim right now.
        if (current) current.tokenStatus = Object.assign({}, current.tokenStatus || {}, { claimable: false });
        renderClaimOption();
        return;
      }
      trackLocal('daily_claim_completed', { source: (current && current.source) || null, streak: data.streak, balance: data.balance, surface: 'out_of_tokens_sheet' });
      if (!current) return;
      current.balance = data.balance;
      current.tokenStatus = Object.assign({}, current.tokenStatus || {}, { claimable: false, balance: data.balance, streak: data.streak });
      renderClaimOption();
      renderPurchaseAmounts();
    }).catch(function () {
      btn.disabled = false;
      label.textContent = CLAIM_INLINE_IDLE_LABEL_PREFIX + ((current.tokenStatus && current.tokenStatus.dailyClaimAmount) || 20) + ' free tokens';
      showError('Couldn’t claim right now — try again in a moment');
    });
  }

  /** Re-renders the title/body/meter off `current.balance`/`current.cost` — extracted out of show() so claimInline() above can refresh the same UI after a successful claim without re-running the whole show() setup (which would re-mount the buy button, re-fire out_of_tokens_shown, etc). */
  function renderPurchaseAmounts() {
    if (!current) return;
    var balance = typeof current.balance === 'number' ? current.balance : 0;
    var cost = typeof current.cost === 'number' ? current.cost : 100;
    var need = neededTokens(balance, cost);
    var mediaLabel = current.mediaType === 'image' ? 'image' : 'video';
    document.getElementById('ps-title').textContent = 'Almost there — this ' + mediaLabel + ' needs ' + cost + ' tokens';
    document.getElementById('ps-body').innerHTML = 'You have <b>' + balance + '</b>. You need <b>' + need + ' more</b>.';
    var pct = cost > 0 ? Math.max(0, Math.min(100, Math.round((balance / cost) * 100))) : 0;
    document.getElementById('ps-meter-fill').style.width = pct + '%';
    document.getElementById('ps-meter-have').textContent = balance;
    document.getElementById('ps-meter-need').textContent = cost;
  }

  function showError(msg) {
    var el = document.getElementById('ps-error');
    el.textContent = msg;
    el.style.display = 'block';
  }

  function wireBuyButton(pack, packInfo, opts) {
    var btn = document.getElementById('ps-buy-btn');
    var label = document.getElementById('ps-buy-label');
    var idleLabel = 'Get ' + packInfo.tokens + ' tokens · $' + packInfo.price.toFixed(2);
    label.textContent = idleLabel;
    btn.disabled = false;
    btn.onclick = function () {
      var email = DreamStore.getAccountEmail();
      if (!email) {
        // Legacy accounts predating required email have nowhere for a Dodo
        // receipt/confirmation to go — same reasoning shop.html's
        // purchasePack() already relies on.
        showError('Add an email to your account first (Profile) to buy tokens');
        return;
      }
      document.getElementById('ps-error').style.display = 'none';
      trackLocal('out_of_tokens_choice', { source: opts.source || null, choice: 'buy_pack', pack: pack });
      trackLocal('checkout_started', { source: opts.source || null, pack: pack, tokens: packInfo.tokens, value: packInfo.price });

      btn.disabled = true;
      label.textContent = 'Redirecting…';

      fetch('/.netlify/functions/create-checkout-session-dodo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: email,
          pack: pack,
          // Relative paths only — create-checkout-session-dodo.js's own
          // server-side guard rejects anything else (see that file's
          // header comment on the open-redirect fix this feature required).
          successUrl: '/processing.html?checkout=success',
          cancelUrl: cancelUrlPath()
        })
      })
        .then(function (res) { return res.json(); })
        .then(function (data) {
          if (data.error || !data.url) throw new Error(data.error || 'no_checkout_url');
          try {
            // Extends shop.html's existing dreamtube_pending_purchase
            // sessionStorage marker shape (same key, same
            // set-before-redirect/consume-once contract — see that file's
            // own header comment) with the fields the blocked-action
            // return trip needs: which action to resume (mediaType/cost)
            // and where this purchase was sourced from, for the
            // blocked_action_resumed / purchase-conversion events fired on
            // return (see consumePendingPurchaseMarker/fireSuccessPurchaseEvents
            // below).
            sessionStorage.setItem(PENDING_PURCHASE_KEY, JSON.stringify({
              pack: pack,
              tokens: packInfo.tokens,
              price: packInfo.price,
              eventId: data.eventId || null,
              purchaseFlow: 'blocked_action',
              source: opts.source || 'blocked_action',
              mediaType: opts.mediaType || null,
              cost: opts.cost || null
            }));
          } catch (e) { /* sessionStorage unavailable (e.g. private mode) — worst case the return trip just won't auto-resume or fire the conversion events */ }
          location.href = data.url;
        })
        .catch(function () {
          btn.disabled = false;
          label.textContent = idleLabel;
          showError('Checkout isn’t available right now — try again soon');
        });
    };
  }

  /** Current page's own URL, with ?checkout=cancelled set (and any pre-existing checkout param removed first) — a same-app-relative path, satisfying create-checkout-session-dodo.js's relative-path-only guard. */
  function cancelUrlPath() {
    var url = new URL(location.href);
    url.searchParams.delete('checkout');
    url.searchParams.set('checkout', 'cancelled');
    return url.pathname + url.search;
  }

  /**
   * Shows the purchase sheet for a single blocked action.
   *
   * opts:
   *   mediaType     — 'video' | 'image'
   *   cost           — tokens this action costs (100 video / 10 image)
   *   balance        — the account's current token balance
   *   tokenStatus    — the full getTokenStatus() response (for the wait line)
   *   source         — analytics source tag, always 'blocked_action' for
   *                     every call site this sheet has today (style.html,
   *                     result.html x2, processing.html's E112/E412 path)
   *   persistDraft   — optional zero-arg function; called BEFORE the sheet
   *                     renders, so the blocked action's full state is
   *                     saved regardless of which of the sheet's exits the
   *                     user takes. Omit when the draft is already known
   *                     intact (processing.html's E112/E412 path).
   *   onDismiss      — optional zero-arg function, called when the sheet
   *                     is dismissed without buying (tap outside)
   */
  function show(opts) {
    opts = opts || {};
    if (typeof opts.persistDraft === 'function') opts.persistDraft();

    ensureMounted();
    current = opts;

    var balance = typeof opts.balance === 'number' ? opts.balance : 0;
    var cost = typeof opts.cost === 'number' ? opts.cost : 100;
    var need = neededTokens(balance, cost);
    var pack = pickSmallestSufficientPack(need);
    var packInfo = PACK_INFO[pack];
    var mediaLabel = opts.mediaType === 'image' ? 'image' : 'video';

    renderPurchaseAmounts();
    document.getElementById('ps-wait-line').textContent = waitLineText(opts.tokenStatus);
    document.getElementById('ps-error').style.display = 'none';
    renderClaimOption();

    wireBuyButton(pack, packInfo, opts);

    document.getElementById(SHEET_ID).classList.add('open');

    trackLocal('out_of_tokens_shown', { source: opts.source || null, mediaType: mediaLabel, cost: cost, balance: balance, needed: need, pack: pack });
    // The inline "Claim +N" affordance above the buy CTA (item 5 of the
    // daily-claim spec) counts as its own claim-surface impression —
    // separate from out_of_tokens_shown above, which fires regardless of
    // whether a claim is even available.
    if (opts.tokenStatus && opts.tokenStatus.claimable) {
      trackLocal('daily_claim_shown', { source: opts.source || null, surface: 'out_of_tokens_sheet' });
    }
  }

  function hide() {
    var el = document.getElementById(SHEET_ID);
    if (el) el.classList.remove('open');
    if (current) {
      trackLocal('out_of_tokens_choice', { source: current.source || null, choice: 'dismiss' });
      if (typeof current.onDismiss === 'function') current.onDismiss();
    }
    current = null;
  }

  // ==========================================================================
  // Balance chip — create.html/style.html/result.html topbars (item 3 of
  // the spec). Extends profile.html's existing .token-chip markup/styling
  // (see css/styles.css) with a compact topbar variant rather than a new
  // design system: same pill shape/class names, smaller, state-tinted
  // (warm/"Low" under 100 tokens) instead of the fixed --gradient-ig fill.
  // Includes the small circled-plus affordance the founder explicitly
  // added to the approved mock (2026-07-26). Taps through to
  // shop.html?source=balance_chip on every page that mounts it.
  // ==========================================================================
  var LOW_BALANCE_THRESHOLD = 100;

  function mountBalanceChip(slotEl) {
    if (!slotEl) return null;
    slotEl.innerHTML =
      '<a class="token-chip token-chip-compact" id="topbar-token-chip" href="shop.html?source=balance_chip">' +
      '<span class="token-chip-balance" id="topbar-token-chip-balance">–</span>' +
      '<span class="token-chip-plus" aria-hidden="true">+</span></a>';
    var chipEl = document.getElementById('topbar-token-chip');
    // Claimable-state tap-through — item 4 of the daily-claim spec: "tapping
    // the chip while in the claimable state opens a claim sheet" instead of
    // its normal shop.html navigation. Reads the live data-claimable
    // attribute at CLICK time (set by renderBalanceChip below on every
    // render) rather than capturing tokenStatus once here, since this
    // listener is attached exactly once at mount time but the chip's
    // claimable state can change on a later re-render (a claim just
    // succeeded elsewhere, a periodic re-fetch, etc).
    chipEl.addEventListener('click', function (e) {
      if (chipEl.getAttribute('data-claimable') !== 'true') return; // normal shop.html navigation
      e.preventDefault();
      showClaimSheet({ source: 'balance_chip', tokenStatus: currentChipTokenStatus(chipEl) });
    });
    return chipEl;
  }

  // Stashes the tokenStatus a chip was last rendered with, keyed off the
  // chip element itself (a plain WeakMap-free approach — this codebase
  // targets no particular minimum browser but avoids introducing a new
  // dependency for one small cache) — read back by the click handler above
  // so the claim sheet opens with real streak/amount data rather than
  // guessing. Not exported; purely an implementation detail of
  // mountBalanceChip/renderBalanceChip.
  var lastChipTokenStatus = null;
  function currentChipTokenStatus(chipEl) {
    return lastChipTokenStatus;
  }

  function renderBalanceChip(chipEl, tokenStatus) {
    if (!chipEl || !tokenStatus) return;
    lastChipTokenStatus = tokenStatus;
    var balEl = chipEl.querySelector('.token-chip-balance');
    var low = tokenStatus.balance < LOW_BALANCE_THRESHOLD;
    if (balEl) balEl.textContent = tokenStatus.balance + (low ? ' · Low' : '');
    chipEl.classList.toggle('low', low);
    chipEl.classList.toggle('healthy', !low);
    // Pulsing "+N claimable" state (item 4 of the daily-claim spec) —
    // data-claimable is the live flag the click handler above reads, the
    // .claimable CSS class (css/styles.css) drives the actual pulse
    // animation + "+N" badge content.
    var claimable = !!tokenStatus.claimable;
    chipEl.classList.toggle('claimable', claimable);
    chipEl.setAttribute('data-claimable', claimable ? 'true' : 'false');
    var plusEl = chipEl.querySelector('.token-chip-plus');
    if (plusEl) {
      var amount = tokenStatus.dailyClaimAmount != null ? tokenStatus.dailyClaimAmount : 20;
      plusEl.textContent = claimable ? ('+' + amount) : '+';
    }
  }

  // ==========================================================================
  // Claim sheet — the dedicated "your daily tokens are ready" sheet (item 4
  // of the daily-claim spec, tracker item
  // for-product-build-the-daily-token-claim--fngrwd). Reuses this file's
  // existing .sheet-overlay/.sheet bottom-sheet infrastructure (same as the
  // out-of-tokens purchase sheet above) rather than building new sheet
  // plumbing from scratch, per the spec's own instruction. Opens either
  // from a tap on the claimable-state balance chip (mountBalanceChip's
  // click handler above), or automatically once per day (see
  // maybeAutoOpenClaimSheet below) — the chip stays the fallback entry
  // point if a user dismisses the auto-opened sheet without claiming.
  // ==========================================================================
  var CLAIM_SHEET_ID = 'claim-sheet-overlay';
  var currentClaim = null; // the opts object passed to the most recent showClaimSheet() call

  function ensureClaimMounted() {
    if (document.getElementById(CLAIM_SHEET_ID)) return;
    var host = document.getElementById('app') || document.body;
    var wrap = document.createElement('div');
    wrap.id = CLAIM_SHEET_ID;
    wrap.className = 'sheet-overlay';
    wrap.innerHTML =
      '<div class="sheet claim-sheet">' +
      '  <div class="sheet-handle"></div>' +
      '  <div class="claim-sheet-badge" aria-hidden="true">🎁</div>' +
      '  <div class="claim-sheet-title">Your daily tokens are ready</div>' +
      '  <div class="claim-sheet-amount" id="claim-sheet-amount">+<span id="claim-sheet-amount-num">0</span></div>' +
      '  <div class="claim-sheet-streak" id="claim-sheet-streak"></div>' +
      '  <button type="button" class="purchase-buy-btn" id="claim-sheet-btn"><span id="claim-sheet-btn-label"></span></button>' +
      '  <div class="purchase-error" id="claim-sheet-error" style="display:none;"></div>' +
      '  <div class="claim-sheet-confetti-host" id="claim-sheet-confetti-host" aria-hidden="true"></div>' +
      '</div>';
    host.appendChild(wrap);
    wrap.addEventListener('click', function (e) {
      if (e.target === wrap) hideClaimSheet(false);
    });
    document.getElementById('claim-sheet-btn').addEventListener('click', function () { runClaim(); });
  }

  /** Animates `#claim-sheet-amount-num` counting up from 0 to `amount` over roughly `durationMs` — the "count-up animation" the spec calls for on a successful claim. Pure DOM text updates via requestAnimationFrame, no dependency. */
  function animateCountUp(amount, durationMs) {
    var el = document.getElementById('claim-sheet-amount-num');
    if (!el) return;
    var start = null;
    function step(ts) {
      if (start === null) start = ts;
      var progress = Math.min(1, (ts - start) / durationMs);
      el.textContent = Math.round(progress * amount);
      if (progress < 1) requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  }

  var CONFETTI_COLORS = ['#fd1d1d', '#fcb045', '#833ab4', '#5fb88a', '#9ab0ff'];

  /** Brief, self-contained confetti burst (a handful of colored dots, CSS-keyframe fall+spin+fade — see .claim-confetti-piece in css/styles.css) — no external library, matching this codebase's zero-dependency convention. Appends to `#claim-sheet-confetti-host` and removes itself once the animation finishes. */
  function fireConfetti() {
    var host = document.getElementById('claim-sheet-confetti-host');
    if (!host) return;
    host.innerHTML = '';
    var count = 14;
    for (var i = 0; i < count; i++) {
      var piece = document.createElement('i');
      piece.className = 'claim-confetti-piece';
      piece.style.left = (Math.random() * 100) + '%';
      piece.style.background = CONFETTI_COLORS[i % CONFETTI_COLORS.length];
      piece.style.animationDelay = (Math.random() * 0.15) + 's';
      piece.style.transform = 'rotate(' + Math.round(Math.random() * 360) + 'deg)';
      host.appendChild(piece);
    }
    setTimeout(function () { host.innerHTML = ''; }, 1400);
  }

  /**
   * opts:
   *   source      — analytics source tag ('balance_chip' | 'auto_open')
   *   tokenStatus — the getTokenStatus() response this open was triggered
   *                 from (for the streak line / claim amount) — optional,
   *                 falls back to sane defaults if omitted
   *   onClaimed   — optional function(data), called with the server's
   *                 { claimed:true, balance, streak, nextClaimAt } response
   *                 once a real claim lands, so the caller can refresh its
   *                 own balance chip/UI
   *   onDismiss   — optional zero-arg function, called if the sheet is
   *                 closed (tap outside) without claiming
   */
  function showClaimSheet(opts) {
    opts = opts || {};
    ensureClaimMounted();
    currentClaim = opts;

    var status = opts.tokenStatus || {};
    var amount = status.dailyClaimAmount != null ? status.dailyClaimAmount : 20;
    var streak = status.streak || 0;
    // Streak line is display-only (v1 exclusion: no escalation/milestone/
    // freeze logic tied to it, per the spec) — "Day N" is the NEXT streak
    // number this claim would produce (current streak + 1, or Day 1 for a
    // genuinely first-ever claim), matching how a user reads "Day 3" as
    // "this is my 3rd day claiming," not "I've claimed 3 times before
    // today."
    document.getElementById('claim-sheet-streak').textContent = 'Day ' + (streak + 1);
    document.getElementById('claim-sheet-amount-num').textContent = '0';
    document.getElementById('claim-sheet-btn-label').textContent = 'Claim ' + amount + ' tokens';
    var btn = document.getElementById('claim-sheet-btn');
    btn.disabled = false;
    var errEl = document.getElementById('claim-sheet-error');
    errEl.style.display = 'none';
    document.getElementById('claim-sheet-confetti-host').innerHTML = '';

    document.getElementById(CLAIM_SHEET_ID).classList.add('open');
    trackLocal('daily_claim_shown', { source: opts.source || null, surface: 'claim_sheet' });
  }

  function hideClaimSheet(claimed) {
    var el = document.getElementById(CLAIM_SHEET_ID);
    if (el) el.classList.remove('open');
    if (currentClaim && !claimed) {
      trackLocal('daily_claim_dismissed', { source: currentClaim.source || null });
      if (typeof currentClaim.onDismiss === 'function') currentClaim.onDismiss();
    }
    currentClaim = null;
  }

  /**
   * The claim sheet's own "Claim N tokens" button handler — a genuine
   * server-confirmed claim (never optimistic): fires `daily_claim_completed`
   * ONLY once DreamStore.claimDailyTokens() actually resolves with
   * `claimed:true`. On success: count-up animation + brief confetti (both
   * pure ritual, no further server round-trip), then auto-closes the sheet
   * shortly after so the ritual has time to land before it disappears.
   */
  function runClaim() {
    if (!currentClaim) return;
    var btn = document.getElementById('claim-sheet-btn');
    var label = document.getElementById('claim-sheet-btn-label');
    var errEl = document.getElementById('claim-sheet-error');
    btn.disabled = true;
    errEl.style.display = 'none';
    label.textContent = 'Claiming…';

    DreamStore.claimDailyTokens().then(function (data) {
      if (!data || !data.claimed) {
        // Not an error (see claim-daily-tokens.js's own doc comment) — most
        // likely another tab/request already claimed this cooldown window.
        // Nothing left to claim; say so plainly and let the user dismiss.
        label.textContent = 'Already claimed';
        errEl.textContent = 'Looks like you already claimed today — check back later.';
        errEl.style.display = 'block';
        return;
      }
      var amount = (currentClaim.tokenStatus && currentClaim.tokenStatus.dailyClaimAmount) || 20;
      animateCountUp(amount, 650);
      fireConfetti();
      document.getElementById('claim-sheet-streak').textContent = 'Day ' + data.streak;
      label.textContent = 'Claimed!';
      trackLocal('daily_claim_completed', { source: currentClaim.source || null, streak: data.streak, balance: data.balance, surface: 'claim_sheet' });
      var onClaimed = currentClaim.onClaimed;
      setTimeout(function () {
        hideClaimSheet(true);
        if (typeof onClaimed === 'function') onClaimed(data);
      }, 1100);
    }).catch(function () {
      btn.disabled = false;
      label.textContent = 'Claim ' + ((currentClaim.tokenStatus && currentClaim.tokenStatus.dailyClaimAmount) || 20) + ' tokens';
      errEl.textContent = 'Couldn’t claim right now — try again in a moment';
      errEl.style.display = 'block';
    });
  }

  // Pure presentation throttle for the "auto-open ONCE per day" rule (item
  // 4 of the spec) — NEVER the actual grant guard, which is entirely
  // server-side (claimDailyTokens' own 20h rolling cooldown, see
  // lib/entitlements.js). This is just "don't nag the same browser with an
  // auto-popup more than once per calendar day" — a plain local calendar
  // date (not a rolling 20h window) is fine here specifically BECAUSE it's
  // pure presentation: the worst this can ever do wrong is show (or not
  // show) an unprompted sheet slightly early/late relative to the real
  // cooldown, never grant a token — the chip remains the fallback entry
  // point regardless.
  var CLAIM_AUTO_SHOWN_KEY = 'dreamtube_claim_sheet_shown_date';

  /**
   * Auto-opens the claim sheet if `tokenStatus.claimable` is true AND this
   * browser hasn't already auto-shown it today. Call once per eligible page
   * load, after fetching tokenStatus. Returns true if it opened the sheet
   * (so a caller doesn't also need to track this itself), false otherwise —
   * including the "already claimable but already shown today, chip is the
   * fallback" case.
   */
  function maybeAutoOpenClaimSheet(tokenStatus, opts) {
    if (!tokenStatus || !tokenStatus.claimable) return false;
    var today = new Date().toDateString();
    var shownDate = null;
    try { shownDate = localStorage.getItem(CLAIM_AUTO_SHOWN_KEY); } catch (e) { /* private mode / storage disabled — fail toward not nagging every load */ return false; }
    if (shownDate === today) return false;
    try { localStorage.setItem(CLAIM_AUTO_SHOWN_KEY, today); } catch (e) { /* worst case this shows again next load — never worse than the chip fallback */ }
    showClaimSheet(Object.assign({ source: 'auto_open' }, opts || {}, { tokenStatus: tokenStatus }));
    return true;
  }

  // ==========================================================================
  // Checkout return handling — shared by every page that can be a
  // successUrl/cancelUrl target for a purchase started from this sheet.
  // Today that's only processing.html (successUrl always points there —
  // see wireBuyButton above — since it's the one page that knows how to
  // resume a generation from an intact draft); style.html/result.html only
  // ever see ?checkout=cancelled (their own cancelUrl points back at
  // themselves).
  // ==========================================================================
  var PENDING_PURCHASE_KEY = 'dreamtube_pending_purchase';

  /** Reads + strips the ?checkout= query param (history.replaceState, so a manual refresh doesn't re-trigger anything below) while keeping any other real query params (e.g. result.html's ?id=...) intact. Returns 'success' | 'cancelled' | null. */
  function readCheckoutParam() {
    var params = new URLSearchParams(location.search);
    var checkout = params.get('checkout');
    if (!checkout) return null;
    params.delete('checkout');
    var rest = params.toString();
    history.replaceState(null, '', location.pathname + (rest ? '?' + rest : ''));
    return checkout;
  }

  function clearPendingPurchaseMarker() {
    try { sessionStorage.removeItem(PENDING_PURCHASE_KEY); } catch (e) { /* private mode / storage disabled */ }
  }

  /** Reads + removes (consume-once, same contract as shop.html's own handleCheckoutReturn) the pending-purchase marker. Returns the parsed object, or null if absent/unparseable. */
  function consumePendingPurchaseMarker() {
    var raw = null;
    try {
      raw = sessionStorage.getItem(PENDING_PURCHASE_KEY);
      sessionStorage.removeItem(PENDING_PURCHASE_KEY);
    } catch (e) { /* private mode / storage disabled */ }
    if (!raw) return null;
    try { return JSON.parse(raw); } catch (e) { return null; }
  }

  /**
   * Fires the same Purchase/purchase_completed conversion pair
   * shop.html's own ?checkout=success handler fires, using the identical
   * marker shape + dedup mechanics (shared eventId with dodo-webhook.js's
   * server-side fire — see docs/EVENT_TAXONOMY.md's Purchase entry). A
   * purchase that started from THIS sheet returns to processing.html, not
   * shop.html, so shop.html's own copy of this logic never runs for it —
   * without this, a real purchase made through the out-of-tokens sheet
   * would silently never get reported as a Purchase at all.
   */
  function fireSuccessPurchaseEvents(pending) {
    if (!pending) return;
    var purchaseProps = { pack: pending.pack, tokens: pending.tokens, value: pending.price, currency: 'USD' };
    if (pending.eventId) purchaseProps.$insert_id = pending.eventId;
    trackLocal('purchase_completed', purchaseProps);
    if (typeof window.fireMetaConversion === 'function') {
      try {
        window.fireMetaConversion('Purchase', { custom_data: { value: pending.price, currency: 'USD' } }, false, pending.eventId || undefined);
      } catch (e) { /* analytics must never break the app */ }
    }
  }

  function fireCheckoutCancelled(source) {
    trackLocal('checkout_cancelled', { source: source || null });
  }

  function fireBlockedActionResumed(source) {
    trackLocal('blocked_action_resumed', { source: source || null });
  }

  function fireStoreViewed(source) {
    trackLocal('store_viewed', { source: source || null });
  }

  // ==========================================================================
  // Poll-for-credit — processing.html's "Payment received — finishing up"
  // state polls this after a successful checkout return, since Dodo's
  // webhook credit is asynchronous and Netlify Blobs is only eventually
  // consistent (up to ~60s — see netlify/functions/lib/entitlements.js's
  // own doc comment on this). POLL_MAX_MS (75s) sits inside the founder's
  // specified 60-90s window — long enough to comfortably clear that ~60s
  // worst case, not the shorter interval an earlier internal audit flagged
  // as too short.
  // ==========================================================================
  var POLL_INTERVAL_MS = 3000;
  var POLL_MAX_MS = 75000;

  /**
   * opts: { neededBalance, onCredited(status), onTimeout(status), intervalMs, maxMs }
   * intervalMs/maxMs default to the real POLL_INTERVAL_MS/POLL_MAX_MS above
   * — the only reason to override them is test/*.test.js shrinking the
   * ~75s real window down to something a Playwright test can actually run
   * in, without touching the real timing this module ships with.
   * Returns a cancel() function the caller can use to stop polling early
   * (e.g. if the user navigates away).
   */
  function pollForCredit(opts) {
    var intervalMs = typeof opts.intervalMs === 'number' ? opts.intervalMs : POLL_INTERVAL_MS;
    var maxMs = typeof opts.maxMs === 'number' ? opts.maxMs : POLL_MAX_MS;
    var cancelled = false;
    var start = Date.now();
    function poll() {
      if (cancelled) return;
      DreamStore.getTokenStatus().then(function (status) {
        if (cancelled) return;
        if (status.balance >= opts.neededBalance) {
          opts.onCredited(status);
          return;
        }
        if (Date.now() - start >= maxMs) {
          opts.onTimeout(status);
          return;
        }
        setTimeout(poll, intervalMs);
      }).catch(function () {
        if (cancelled) return;
        if (Date.now() - start >= maxMs) {
          opts.onTimeout(null);
          return;
        }
        setTimeout(poll, intervalMs);
      });
    }
    poll();
    return function cancel() { cancelled = true; };
  }

  var PurchaseSheet = {
    PACK_INFO: PACK_INFO,
    PENDING_PURCHASE_KEY: PENDING_PURCHASE_KEY,
    LOW_BALANCE_THRESHOLD: LOW_BALANCE_THRESHOLD,
    pickSmallestSufficientPack: pickSmallestSufficientPack,
    neededTokens: neededTokens,
    formatTokenCountdown: formatTokenCountdown,
    waitLineText: waitLineText,
    show: show,
    hide: hide,
    mountBalanceChip: mountBalanceChip,
    renderBalanceChip: renderBalanceChip,
    showClaimSheet: showClaimSheet,
    hideClaimSheet: hideClaimSheet,
    maybeAutoOpenClaimSheet: maybeAutoOpenClaimSheet,
    readCheckoutParam: readCheckoutParam,
    clearPendingPurchaseMarker: clearPendingPurchaseMarker,
    consumePendingPurchaseMarker: consumePendingPurchaseMarker,
    fireSuccessPurchaseEvents: fireSuccessPurchaseEvents,
    fireCheckoutCancelled: fireCheckoutCancelled,
    fireBlockedActionResumed: fireBlockedActionResumed,
    fireStoreViewed: fireStoreViewed,
    pollForCredit: pollForCredit
  };

  // Browser: attach to window, same as every other js/*.js file in this
  // codebase. Node/test environment (no `window` global): export via
  // module.exports instead, same dual-target pattern as js/wizard-chips.js —
  // lets test/*.test.js require() this file directly for the pure
  // arithmetic/pack-selection logic, without needing a real browser for
  // that part.
  if (typeof window !== 'undefined') window.PurchaseSheet = PurchaseSheet;
  if (typeof module !== 'undefined' && module.exports) module.exports = PurchaseSheet;
})();
