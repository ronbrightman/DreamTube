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
//
// "Make it as an image instead" fallback (tracker item
// for-product-out-of-tokens-sheet-founder--dg5q1y, founder-directed
// 2026-08-01): when the blocked action is specifically a VIDEO generation
// via a general route (style.html's own media-type picker, reached from
// create.html/wizard.html; result.html's edit-delta sheet or the older
// full edit-wizard sheet's "Generate Again"; or home.html's
// onGenerationSettled E112/E412 catch, the generic fail path every
// generation submission funnels through since processing.html was
// removed — see that page's own doc comment) — NOT result.html's "Turn
// this into a video" image-to-video upsell, the founder's explicit
// exclusion — a quiet link under the buy CTA offers the same content as
// a cheaper (10-token) image instead. A call site opts in by passing
// `opts.onImageFallback` (see show()'s own doc comment) — its ABSENCE is
// what keeps the upsell context clean at style.html/result.html's own
// call sites; home.html's single generic catch handler can't rely on
// that alone (it has no record of which page originally submitted a
// failed generation) so it additionally checks the draft's own
// sourceImageUrl (set only by DreamStore.turnImageIntoVideo) before ever
// passing onImageFallback — see that call site's own comment. Shown only
// when the account can actually afford the image (balance >=
// IMAGE_TOKEN_COST) — anything else would be showing an option the user
// still can't take.
// ============================================================================

(function () {
  'use strict';

  // ==========================================================================
  // Pure logic (no DOM) — token packs, arithmetic, countdown formatting.
  // Mirrors shop.html's own PACK_INFO ("The Vault" shop redesign,
  // founder-approved 2026-08-02, tracker item
  // for-product-build-ship-today-founder-app-zn9zyy: $0.99/300 one-time
  // starter, $1.99/500, $4.99/1500 "Most popular", $9.99/4000 "Best
  // value" — REPLACES the old pack100/pack300/pack700 lineup and its
  // +50% first-purchase bonus entirely; fresh pack ids, never reusing the
  // old ones — see create-checkout-session-dodo.js's PACK_TOKENS comment
  // for the full no-grandfathering reasoning). Kept as its own copy
  // rather than a shared import (this codebase has no bundler/require for
  // browser code — see js/store.js's header comment) — same "one small
  // local map, not a shared module" convention shop.html's own PACK_INFO
  // comment already documents.
  // ==========================================================================
  var PACK_INFO = {
    pack099: { tokens: 300, price: 0.99 },
    pack199: { tokens: 500, price: 1.99 },
    pack499: { tokens: 1500, price: 4.99 },
    pack999: { tokens: 4000, price: 9.99 }
  };
  var PACK_ORDER = ['pack099', 'pack199', 'pack499', 'pack999'];

  // pack099 is the one-time-per-account starter — see
  // create-checkout-session-dodo.js's header comment for the server-side
  // enforcement (this sheet's own contextual pack choice below is a UX
  // nicety on TOP of that server-side gate, not a substitute for it: even
  // if this sheet somehow offered pack099 to an ineligible account, the
  // server would still refuse the checkout with E9).
  var STARTER_PACK_ID = 'pack099';

  // Flat cost of one image generation — mirrors generate-image.js's own
  // server-side IMAGE_TOKEN_COST (that file is the real source of truth;
  // this is a local copy, same "no shared browser module" convention
  // already used for style.html's/result.html's/processing.html's own
  // IMAGE_TOKEN_COST copies — see this file's header comment on why no
  // shared module). Needed here for the "make it as an image instead"
  // fallback link below (tracker item
  // for-product-out-of-tokens-sheet-founder--dg5q1y).
  var IMAGE_TOKEN_COST = 10;

  /**
   * The out-of-tokens sheet's "single contextual offer" pack choice
   * (founder spec, tracker item
   * for-product-build-ship-today-founder-app-zn9zyy, §5(c)): the $0.99
   * starter (pack099) if this account has never bought a pack before
   * (`!hasMadeFirstPurchase`), otherwise the $1.99 pack (pack199) — never
   * the two larger packs, and never the starter a second time. Within
   * whichever of those an account is eligible for, picks the cheapest one
   * that alone covers the shortfall (same "smallest sufficient" shape the
   * old pickSmallestSufficientPack used, generalized rather than
   * hardcoded to "always pack099/pack199" so this stays correct if a
   * future, larger-cost action is ever added — in practice, since every
   * generation costs at most 100 tokens (video) or 10 (image) and both
   * eligible packs' token counts comfortably exceed that, this always
   * resolves to the very first eligible pack today).
   */
  function pickContextualPack(neededTokensAmount, hasMadeFirstPurchase) {
    var eligibleOrder = hasMadeFirstPurchase ? PACK_ORDER.slice(1) : PACK_ORDER; // drop the starter once this account has ever bought a pack
    for (var i = 0; i < eligibleOrder.length; i++) {
      var key = eligibleOrder[i];
      if (PACK_INFO[key].tokens >= neededTokensAmount) return key;
    }
    return eligibleOrder[eligibleOrder.length - 1]; // best eligible available, even if not technically "sufficient"
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
  // Review finding (round 3): capturing `current` into a local before an
  // async gap (round 2's fix) stops a null-deref crash, but doesn't stop a
  // STALE-but-non-null capture from still mutating shared singleton DOM
  // (btn/label/#ps-error) after the sheet has been dismissed and reopened
  // for a different blocked action. Same instance-guard pattern already
  // used elsewhere in this codebase (create.html's charSheetToken,
  // profile.html's identitySheetToken): bumped on every show()/hide(),
  // captured locally by claimInline() before its async call, re-checked
  // once it resolves so a stale attempt's DOM-mutating side effects no-op
  // entirely rather than corrupting whatever sheet instance is now open.
  var currentGen = 0;

  function trackLocal(name, props) {
    if (typeof window !== 'undefined' && window.posthog && typeof window.posthog.capture === 'function') {
      try { posthog.capture(name, props || {}); } catch (e) { /* analytics must never break the app */ }
    }
  }

  /**
   * Turns a REJECTED DreamStore.claimDailyTokens() promise's error into
   * honest, outcome-specific copy — shared by runClaim() (the dedicated
   * claim sheet) and claimInline() (the out-of-tokens sheet's inline claim
   * button), the two catch() handlers below this point.
   *
   * 2026-08-05 (tracker item for-product-p1-urgent-fresh-signup-can-d-
   * qhrrqy, round 2, ask #3): both catch() blocks used to show the exact
   * same generic "Couldn't claim right now — try again in a moment" for
   * EVERY rejection — a genuine E4 rate-limit (429, "too many attempts
   * from this network/account today") and a genuine E5 write-failure (500,
   * a real but rare Blobs-propagation race, see lib/entitlements.js's
   * claimDailyTokens doc comment) read to the user as the identical
   * message, even though one means "come back tomorrow" and the other
   * means "try again in a few seconds, this is likely to work". Note this
   * is DIFFERENT from the honest-but-unqualified "Looks like you already
   * claimed today" copy in the .then() branch below (a genuine, non-error
   * `{claimed:false}` 200 response) — that branch was already accurate
   * and is untouched here.
   *
   * `err.message` is whatever DreamStore.claimDailyTokens threw — the
   * server's own `error` string verbatim (e.g. "E4: rate_limited: too
   * many claim attempts..." or "E5: claim_write_failed: ..."), per that
   * function's own doc comment. A plain network failure (fetch itself
   * rejecting, before any server response) carries neither prefix and
   * falls through to the same generic retry copy as E5 — both are
   * genuinely transient, worth an immediate retry, and correctly
   * indistinguishable to the user either way.
   */
  function claimErrorCopy(err) {
    var message = (err && err.message) || '';
    if (/^E4:/.test(message)) {
      return 'Too many attempts from this network today — try again tomorrow.';
    }
    return 'Couldn’t claim right now — try again in a moment';
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
      // "Make it as an image instead" quiet-link fallback (tracker item
      // for-product-out-of-tokens-sheet-founder--dg5q1y) — directly under
      // the primary buy CTA per the founder's spec, hidden by default
      // (display:none) and only shown by show() below when a call site
      // opts in via `onImageFallback` AND the account can actually afford
      // the cheaper image. Deliberately its own quiet class (not
      // .purchase-see-all's styling) — smaller/more muted, so it doesn't
      // compete with the primary CTA the way "See all packs" already sits
      // one step below it.
      '  <div class="purchase-image-fallback" id="ps-image-fallback" style="display:none;"></div>' +
      '  <div class="purchase-error" id="ps-error" style="display:none;"></div>' +
      '  <div class="purchase-see-all" id="ps-see-all">See all packs →</div>' +
      '  <div class="purchase-wait-line" id="ps-wait-line"></div>' +
      '  <div class="purchase-trust">Secure checkout via Dodo — one-time, no subscription</div>' +
      '</div>';
    host.appendChild(wrap);

    // Tap-outside-to-dismiss AND touch drag-to-dismiss — shared behavior
    // for every .sheet-overlay in this app (see js/sheet-dismiss.js's own
    // header comment; tracker item
    // for-product-sheet-dismissal-app-wide-fix-rlay70). hide() below does
    // its own currentGen bump/onDismiss firing, same as every other
    // dismissal path (Close/Cancel button) already does.
    SheetDismiss.wire(wrap, hide);
    document.getElementById('ps-see-all').addEventListener('click', function () {
      if (current) trackLocal('out_of_tokens_choice', { source: current.source || null, choice: 'see_all_packs' });
      location.href = 'shop.html?source=blocked_action';
    });
    document.getElementById('ps-claim-btn').addEventListener('click', function () { claimInline(); });
    document.getElementById('ps-image-fallback').addEventListener('click', function () { handleImageFallbackTap(); });
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
   * Shows/hides the "or make it as an image instead — N tokens" quiet
   * link per the CURRENT `current` — called from show() only (unlike
   * renderClaimOption/renderPurchaseAmounts, this never needs re-rendering
   * mid-sheet-lifetime: a successful inline claim can only ever raise the
   * balance further above IMAGE_TOKEN_COST, never take an already-shown
   * link away, and re-running the whole eligibility check on every claim
   * isn't worth the complexity for a link that would never disappear
   * anyway).
   *
   * Eligible only when ALL of:
   *  - the call site opted in with a real `onImageFallback` function (its
   *    ABSENCE is what keeps result.html's "Turn this into a video"
   *    image-to-video upsell — the founder's explicit exclusion — clean;
   *    see this file's header comment)
   *  - the blocked action itself is a video (`opts.mediaType === 'video'`
   *    — defense in depth alongside the call site's own opt-in, same
   *    "don't rely on a single gate" posture the rest of this file uses)
   *  - the account can actually afford the cheaper image right now
   *    (`balance >= IMAGE_TOKEN_COST`) — otherwise offering it would be
   *    showing an option the user still can't take (the founder's own
   *    "otherwise it's a lie" framing).
   */
  function renderImageFallback(opts, balance) {
    var el = document.getElementById('ps-image-fallback');
    var eligible = typeof opts.onImageFallback === 'function' &&
      opts.mediaType === 'video' &&
      balance >= IMAGE_TOKEN_COST;
    if (!eligible) {
      el.style.display = 'none';
      el.textContent = '';
      return;
    }
    el.textContent = 'or make it as an image — ' + IMAGE_TOKEN_COST + ' tokens';
    el.style.display = 'block';
  }

  /**
   * Click handler for the "make it as an image instead" link — fires the
   * dedicated `out_of_tokens_image_fallback_tapped` event (tracker item
   * for-product-out-of-tokens-sheet-founder--dg5q1y), then closes this
   * sheet instance WITHOUT the normal dismiss tracking/onDismiss callback
   * (tapping this link is a real choice, not a dismiss — same reasoning
   * the buy button's own click handler never calls hide() either, it just
   * navigates away), then hands off to the call site's own
   * `onImageFallback()` — which knows, per its own page, whether that
   * means navigating to home.html?generate=1 with the draft's mediaType
   * flipped to 'image' (style.html/result.html, mirroring their own
   * unblocked-path navigation) or retrying generation in place
   * (home.html's own onGenerationSettled E112/E412 catch, already on the
   * page that generates).
   */
  function handleImageFallbackTap() {
    if (!current || typeof current.onImageFallback !== 'function') return;
    var target = current;
    trackLocal('out_of_tokens_image_fallback_tapped', { source: target.source || null, cost: IMAGE_TOKEN_COST });
    var el = document.getElementById(SHEET_ID);
    if (el) el.classList.remove('open');
    current = null;
    currentGen++;
    target.onImageFallback();
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
   *
   * Review finding (round 2): this used to dereference the shared
   * module-level `current` directly inside the .then()/.catch()
   * callbacks — the identical stale-async-callback shape runClaim() (the
   * dedicated claim sheet's own button handler) was fixed for in round 1,
   * just unfixed here in this sibling function since round 1 only looked
   * at the one function its own finding named. hide() (tap-outside
   * dismiss on THIS sheet) nulls `current` with no in-flight guard, so
   * dismissing while a claim request is still pending crashed the
   * .catch() on `current.tokenStatus` being null. Fixed by capturing the
   * triggering `current` into a local `claimTarget` before the async gap.
   *
   * Review finding (round 3): that fix stopped the CRASH but not the
   * deeper issue — a stale (non-null) `claimTarget` can still mutate the
   * shared singleton `#ps-claim-btn`/`#ps-claim-label`/`#ps-error` DOM
   * nodes after the sheet was dismissed and reopened for a DIFFERENT
   * blocked action, corrupting whatever the user is now looking at. Fixed
   * the same instance-guard way this codebase already uses elsewhere
   * (create.html's charSheetToken, profile.html's identitySheetToken):
   * `currentGen` is bumped on every show()/hide(), captured here as
   * `myGen` before the async call, and every DOM-mutating branch below is
   * gated on `myGen === currentGen` — a stale attempt's side effects
   * simply no-op rather than touching a sheet instance they don't belong
   * to. `daily_claim_completed` still fires either way (it's an accurate
   * record of what genuinely happened server-side, not a DOM mutation).
   *
   * Review finding (round 4): this sheet's own internal DOM was the ONLY
   * thing that ever refreshed after a successful inline claim — the
   * caller's own cached `tokenStatus`/topbar balance chip never learned
   * about it at all (unlike `runClaim()` above, which always calls
   * `claimOpts.onClaimed(data)`). Concretely: style.html/result.html/
   * processing.html each cache their own `tokenStatus` in a closure
   * variable, checked by `tokensBlockGeneration()` on every later attempt
   * — without this callback, a user who claims inline specifically to
   * unblock a cheap action (the feature's own "instantly unblocks an
   * image" promise) stays blocked on retry by stale client state, and the
   * topbar chip keeps pulsing "claimable" after tokens were already
   * claimed. Fixed by calling `claimTarget.onClaimed(data)` unconditionally
   * on a real claim, same "fires regardless of sheet staleness" posture
   * already used for `daily_claim_completed`/`runClaim`'s own `onClaimed`
   * — the credit genuinely happened and the caller's state should reflect
   * it no matter which sheet instance is currently on screen.
   */
  function claimInline() {
    if (!current) return;
    var claimTarget = current;
    var myGen = currentGen;
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
        if (myGen !== currentGen) return;
        claimTarget.tokenStatus = Object.assign({}, claimTarget.tokenStatus || {}, { claimable: false });
        renderClaimOption();
        return;
      }
      trackLocal('daily_claim_completed', { source: claimTarget.source || null, streak: data.streak, balance: data.balance, surface: 'out_of_tokens_sheet' });
      if (typeof claimTarget.onClaimed === 'function') claimTarget.onClaimed(data);
      if (myGen !== currentGen) return;
      claimTarget.balance = data.balance;
      claimTarget.tokenStatus = Object.assign({}, claimTarget.tokenStatus || {}, { claimable: false, balance: data.balance, streak: data.streak });
      renderClaimOption();
      renderPurchaseAmounts();
    }).catch(function (err) {
      if (myGen !== currentGen) return;
      btn.disabled = false;
      label.textContent = CLAIM_INLINE_IDLE_LABEL_PREFIX + ((claimTarget.tokenStatus && claimTarget.tokenStatus.dailyClaimAmount) || 20) + ' free tokens';
      showError(claimErrorCopy(err));
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
      // Round-5 review finding: this was the one remaining async callback
      // in this file with no currentGen staleness guard (every other one
      // -- claimInline/runClaim -- was fixed in earlier rounds for the
      // same reason). Captured here, at click-time, since the fetch only
      // starts on click; checked before the .catch() branch below mutates
      // btn/label, since a dismiss-then-reopen-for-a-different-item while
      // this checkout POST is still in flight would otherwise let a
      // failure response overwrite the CURRENTLY open sheet's button with
      // this stale click's idleLabel/error text. The success path isn't
      // gated -- it only navigates away (location.href), never mutates
      // this sheet's DOM, so there's nothing stale to guard there.
      var myGen = currentGen;
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

      // Returning-buyer prefill (tracker item
      // for-product-repeat-purchase-friction-dod-b6pzs6) — same optional,
      // already-cached-locally password shop.html's own purchasePack()
      // sends; see that file's comment and DreamStore.getCachedPassword's
      // own doc comment for the full reasoning. Omitted entirely when
      // there's nothing cached, exactly like today.
      var cachedPassword = DreamStore.getCachedPassword();
      var checkoutBody = {
        email: email,
        pack: pack,
        // Relative paths only — create-checkout-session-dodo.js's own
        // server-side guard rejects anything else (see that file's
        // header comment on the open-redirect fix this feature required).
        // Home.html (tracker item for-product-funnel-ending-v2-founder-
        // ins-tfuu0q — processing.html removed) is now the one page that
        // knows how to pick a persisted draft back up and actually run
        // the generation once the purchase lands — see that page's own
        // "Dodo-checkout-return resume" script block.
        successUrl: '/home.html?checkout=success',
        cancelUrl: cancelUrlPath()
      };
      if (cachedPassword) checkoutBody.password = cachedPassword;

      fetch('/.netlify/functions/create-checkout-session-dodo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(checkoutBody)
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
              // Carried through to the eventual purchase_completed fire
              // (see fireSuccessPurchaseEvents below) so growth can
              // measure starter-pack conversion specifically — mirrors
              // dodo-webhook.js's own server-side Purchase event's
              // `starter` flag (tracker item
              // for-product-build-ship-today-founder-app-zn9zyy, item 5).
              starter: pack === STARTER_PACK_ID,
              purchaseFlow: 'blocked_action',
              source: opts.source || 'blocked_action',
              mediaType: opts.mediaType || null,
              cost: opts.cost || null
            }));
          } catch (e) { /* sessionStorage unavailable (e.g. private mode) — worst case the return trip just won't auto-resume or fire the conversion events */ }
          location.href = data.url;
        })
        .catch(function () {
          if (myGen !== currentGen) return;
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
   *   onClaimed      — optional function(data), called with the server's
   *                     { claimed:true, balance, streak, nextClaimAt }
   *                     response once the inline "Claim +N" button
   *                     (claimInline, item 5 of the daily-claim spec)
   *                     lands a real claim — so the caller can refresh its
   *                     own cached tokenStatus/topbar balance chip (review
   *                     finding, round 4: without this, a claim made
   *                     specifically to unblock the current action left
   *                     the caller's state stale, defeating this feature's
   *                     own "instantly unblocks" promise). Same
   *                     unconditional-regardless-of-staleness posture as
   *                     showClaimSheet's own onClaimed.
   *   onImageFallback — optional zero-arg function (tracker item
   *                     for-product-out-of-tokens-sheet-founder--dg5q1y).
   *                     Its mere PRESENCE (combined with mediaType==='video'
   *                     and a sufficient balance — see renderImageFallback)
   *                     is what shows the "or make it as an image instead
   *                     — 10 tokens" quiet link under the buy CTA — omit
   *                     it entirely for any call site that must never
   *                     offer this (result.html's "Turn this into a
   *                     video" image-to-video upsell, the founder's
   *                     explicit exclusion). Called on tap, AFTER this
   *                     sheet instance has already been closed (no
   *                     dismiss tracking/onDismiss fired) — responsible
   *                     for flipping the SAME already-persisted draft's
   *                     mediaType to 'image' (DreamStore.setDraft) and
   *                     either navigating to home.html?generate=1 or, if
   *                     already there (home.html's own E112/E412 catch),
   *                     retrying generation in place.
   */
  function show(opts) {
    opts = opts || {};
    if (typeof opts.persistDraft === 'function') opts.persistDraft();

    ensureMounted();
    current = opts;
    currentGen++;

    var balance = typeof opts.balance === 'number' ? opts.balance : 0;
    var cost = typeof opts.cost === 'number' ? opts.cost : 100;
    var need = neededTokens(balance, cost);
    // Single contextual offer (see pickContextualPack's own doc comment):
    // starter if this account hasn't used it yet, else the $1.99 pack. A
    // missing/undefined tokenStatus (shouldn't happen in practice — every
    // real call site passes the getTokenStatus() response — but this sheet
    // must never crash over it) fails toward `hasMadeFirstPurchase: false`
    // (offer the starter) rather than `true`: withholding a real discount
    // from an eligible buyer over a missing field is a worse failure mode
    // than occasionally re-offering it, and the E9 server-side guard is
    // the actual enforcement backstop either way.
    var hasMadeFirstPurchase = !!(opts.tokenStatus && opts.tokenStatus.hasMadeFirstPurchase);
    var pack = pickContextualPack(need, hasMadeFirstPurchase);
    var packInfo = PACK_INFO[pack];
    var mediaLabel = opts.mediaType === 'image' ? 'image' : 'video';

    renderPurchaseAmounts();
    document.getElementById('ps-wait-line').textContent = waitLineText(opts.tokenStatus);
    document.getElementById('ps-error').style.display = 'none';
    renderClaimOption();
    renderImageFallback(opts, balance);

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
    currentGen++;
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

  /**
   * opts:
   *   plain  — render the PLAIN variant: balance + a "Shop" affordance, and
   *            nothing else. No low/healthy tinting, no pulsing claimable
   *            state, no "+N" badge, and — most importantly — no
   *            tap-to-open-the-claim-sheet handler at all. Added for
   *            profile.html's night restyle (tracker item
   *            for-product-build-founder-approved-2026--to6ew2), where the
   *            founder's spec deletes every claim/ritual mechanic from
   *            Profile: home.html is the sole claim surface now, and a
   *            second, quieter one on Profile was the exact drift being
   *            removed. The plain-ness is carried by the rendered element's
   *            own `token-chip-plain` class rather than by module state, so
   *            renderBalanceChip below cannot accidentally re-apply claim
   *            styling to it later (a caller can't forget to pass the flag
   *            a second time).
   *   source — analytics/source tag appended to the shop.html link
   *            (defaults to 'balance_chip', the pre-existing value).
   */
  function mountBalanceChip(slotEl, opts) {
    if (!slotEl) return null;
    opts = opts || {};
    var source = opts.source || 'balance_chip';
    if (opts.plain) {
      slotEl.innerHTML =
        '<a class="token-chip token-chip-plain" id="topbar-token-chip" href="shop.html?source=' + encodeURIComponent(source) + '">' +
        '<span class="token-chip-star tok-ico" aria-hidden="true">' + (window.Icons ? Icons.token : '✦') + '</span>' +
        '<span class="token-chip-balance" id="topbar-token-chip-balance">–</span>' +
        '<span class="token-chip-sep" aria-hidden="true">·</span>' +
        '<span class="token-chip-cta">Shop</span></a>';
      // Deliberately no click listener: the plain chip is a plain link to
      // the shop, in every token state.
      return document.getElementById('topbar-token-chip');
    }
    slotEl.innerHTML =
      '<a class="token-chip token-chip-compact" id="topbar-token-chip" href="shop.html?source=' + encodeURIComponent(source) + '">' +
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
      showClaimSheet({
        source: 'balance_chip',
        tokenStatus: currentChipTokenStatus(chipEl),
        // Review finding (round 2): every page's own maybeAutoOpenClaimSheet
        // wiring passes an onClaimed that re-fetches + re-renders the chip
        // (see create.html/style.html/result.html/explore.html), but this
        // chip's OWN click-to-claim path never did -- so a claim triggered
        // by tapping the chip directly (rather than the auto-opened sheet)
        // left the chip showing the stale pre-claim balance, still pulsing
        // "claimable", until the next full page load. Self-contained here
        // rather than requiring every page to wire it separately.
        onClaimed: function () {
          DreamStore.getTokenStatus().then(function (fresh) {
            renderBalanceChip(chipEl, fresh);
          }).catch(function () { /* stale chip until the next natural refresh -- not worth surfacing an error for */ });
        }
      });
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
    var balEl = chipEl.querySelector('.token-chip-balance');
    // Plain variant (see mountBalanceChip's `plain` option): the balance
    // number and nothing else — no low/healthy tint, no claimable pulse,
    // no "+N" badge, no data-claimable attribute for anything to key off.
    // Gated on the element's own class so this stays correct no matter how
    // many times, or from where, a caller re-renders it.
    //
    // Returns BEFORE touching `lastChipTokenStatus` on purpose: that
    // module-level cache exists solely so a COMPACT chip's tap-to-claim
    // handler can open the claim sheet with real streak/amount data. A
    // plain chip has no such handler, so letting it write there would be
    // shared state leaking across chip instances for no reader — exactly
    // the cross-instance-state bug class this file has been fixed for
    // repeatedly (see claimInline/runClaim's own review-finding notes).
    if (chipEl.classList.contains('token-chip-plain')) {
      if (balEl) balEl.textContent = tokenStatus.balance;
      return;
    }
    lastChipTokenStatus = tokenStatus;
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
  // Same instance-guard purpose as `currentGen` above (see its own doc
  // comment) — bumped on every showClaimSheet()/hideClaimSheet(), captured
  // by runClaim() before its async call so a stale attempt (the sheet was
  // dismissed and reopened before the original request resolved) can't
  // run its ritual/auto-close against a sheet instance it doesn't belong
  // to (review finding, round 3).
  var claimGen = 0;

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
      '  <div class="claim-sheet-balance" id="claim-sheet-balance" style="display:none;">New balance: <span id="claim-sheet-balance-num">0</span></div>' +
      '  <button type="button" class="purchase-buy-btn" id="claim-sheet-btn"><span id="claim-sheet-btn-label"></span></button>' +
      '  <div class="purchase-error" id="claim-sheet-error" style="display:none;"></div>' +
      '  <div class="claim-sheet-confetti-host" id="claim-sheet-confetti-host" aria-hidden="true"></div>' +
      '</div>';
    host.appendChild(wrap);
    // Same shared tap-outside + drag-to-dismiss wiring as the purchase
    // sheet above (js/sheet-dismiss.js) — hideClaimSheet(false) is the
    // same dismissal path the Cancel/tap-outside case already used.
    SheetDismiss.wire(wrap, function () { hideClaimSheet(false); });
    document.getElementById('claim-sheet-btn').addEventListener('click', function () { runClaim(); });
  }

  /**
   * Animates `el`'s text counting from `from` to `to` over roughly
   * `durationMs`, via requestAnimationFrame (no dependency). Founder
   * directive (2026-07-28, matching the Duolingo/mobile-game daily-reward
   * pattern): the count-up ritual belongs on the BALANCE after a
   * successful claim, not on the reward amount a second time — the reward
   * amount (+20) is shown up front, in full, the instant the sheet opens
   * (see showClaimSheet below), never as a 0-to-N animation. This is now
   * the sole caller of a count-up in this sheet; `from`/`to` are passed in
   * explicitly (rather than always starting at 0) so it can animate the
   * pre-claim -> post-claim balance. Falls back to just setting `to`
   * directly (no animation) if `from` isn't a real number — e.g. the
   * pre-claim balance wasn't available for some reason — since animating
   * from an unknown/wrong start would be worse than not animating at all.
   */
  function animateCountUp(el, from, to, durationMs) {
    if (!el) return;
    if (typeof from !== 'number' || isNaN(from)) {
      el.textContent = to;
      return;
    }
    var start = null;
    function step(ts) {
      if (start === null) start = ts;
      var progress = Math.min(1, (ts - start) / durationMs);
      el.textContent = Math.round(from + (to - from) * progress);
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
    claimGen++;

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
    // Founder directive (2026-07-28, Duolingo/mobile-game daily-reward
    // pattern): show the REAL reward amount up front, the instant the
    // sheet opens — never a 0 placeholder (that produced the confusing
    // "big +0 above Day 1" both the founder and a real user screenshotted;
    // tracker item for-product-daily-claim-bugs-founder-rea-kei2ub). The
    // count-up ritual moves to the balance display below, on a successful
    // claim, instead of re-animating this same number a second time.
    document.getElementById('claim-sheet-amount-num').textContent = amount;
    document.getElementById('claim-sheet-btn-label').textContent = 'Claim ' + amount + ' tokens';
    var btn = document.getElementById('claim-sheet-btn');
    btn.disabled = false;
    var errEl = document.getElementById('claim-sheet-error');
    errEl.style.display = 'none';
    document.getElementById('claim-sheet-confetti-host').innerHTML = '';
    // Reset the balance count-up display (hidden until a claim actually
    // succeeds — see runClaim below) so a reopened sheet never shows a
    // leftover balance number from a previous claim.
    document.getElementById('claim-sheet-balance').style.display = 'none';
    document.getElementById('claim-sheet-balance-num').textContent = '0';

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
    claimGen++;
  }

  /**
   * The claim sheet's own "Claim N tokens" button handler — a genuine
   * server-confirmed claim (never optimistic): fires `daily_claim_completed`
   * ONLY once DreamStore.claimDailyTokens() actually resolves with
   * `claimed:true`. On success: count-up animation + brief confetti (both
   * pure ritual, no further server round-trip), then auto-closes the sheet
   * shortly after so the ritual has time to land before it disappears.
   *
   * Review finding (round 1): this used to keep dereferencing the shared
   * module-level `currentClaim` INSIDE the .then()/.catch() callbacks —
   * exactly the stale-async-callback bug shape this codebase has hit and
   * fixed before (the identitySheetToken/charSheetToken instance-guard
   * pattern on the photo-upload sheets). If the user tapped outside the
   * sheet (hideClaimSheet(false), which nulls currentClaim) while this
   * request was still in flight, the callback would dereference `null`
   * and throw — silently dropping a genuinely successful server-side
   * claim's onClaimed callback (so the caller's balance chip never
   * refreshes) and its daily_claim_completed analytics fire, even though
   * the tokens really were credited. Fixed by capturing the triggering
   * opts in a LOCAL `claimOpts` at the top, before the async gap.
   *
   * Review finding (round 3): capturing `claimOpts` stopped the CRASH but
   * not the deeper issue — a stale (non-null) `claimOpts` can still run
   * the whole success ritual (count-up, confetti, streak text) and,
   * worse, forcibly auto-close a DIFFERENT sheet instance the user
   * reopened in the meantime (dismiss -> tap the still-"claimable" chip
   * again before this request resolves -> a genuinely new showClaimSheet()
   * session is now open when the ORIGINAL request finally settles). Fixed
   * with the same instance-guard this codebase already uses elsewhere
   * (create.html's charSheetToken, profile.html's identitySheetToken):
   * `claimGen` is bumped on every showClaimSheet()/hideClaimSheet(),
   * captured here as `myGen`, and every DOM-mutating/auto-close branch
   * below is gated on `myGen === claimGen`. `daily_claim_completed` and
   * `onClaimed` still fire unconditionally either way — they're accurate
   * regardless of sheet staleness (the credit genuinely happened, and the
   * caller's balance chip should refresh no matter which sheet instance
   * is currently on screen) — only the sheet-instance-local ritual/close
   * is gated.
   */
  function runClaim() {
    if (!currentClaim) return;
    var claimOpts = currentClaim;
    var myGen = claimGen;
    var btn = document.getElementById('claim-sheet-btn');
    var label = document.getElementById('claim-sheet-btn-label');
    var errEl = document.getElementById('claim-sheet-error');
    btn.disabled = true;
    errEl.style.display = 'none';
    label.textContent = 'Claiming…';

    DreamStore.claimDailyTokens().then(function (data) {
      if (!data || !data.claimed) {
        // Not necessarily an error (see claim-daily-tokens.js's own doc
        // comment) — most often another tab/request already claimed this
        // cooldown window. But it can also be an HONEST server-side "not
        // yet" for a request that raced its own account's just-landed
        // setup (e.g. a fresh signup's auto-opened claim sheet, tracker
        // item for-product-bug-founder-repro-high-brand-1dtzdc) — a case
        // where trying again is genuinely likely to succeed. Round 2 fix
        // (same tracker item): this branch used to leave the button
        // permanently disabled with no way to act on this message except
        // dismissing the whole sheet — a real dead end the founder's own
        // repro hit ("saw NOTHING" when a claim attempt silently didn't
        // land). Re-enabling it with an explicit "Try again" CTA costs
        // nothing on a genuine already-claimed outcome (the server just
        // reports the same honest claimed:false again) and gives a real
        // recovery path on a transient race — never worse than before,
        // sometimes strictly better.
        if (myGen !== claimGen) return;
        btn.disabled = false;
        label.textContent = 'Try again';
        errEl.textContent = 'Looks like you already claimed today — check back later.';
        errEl.style.display = 'block';
        return;
      }
      trackLocal('daily_claim_completed', { source: claimOpts.source || null, streak: data.streak, balance: data.balance, surface: 'claim_sheet' });
      var onClaimed = claimOpts.onClaimed;
      if (typeof onClaimed === 'function') onClaimed(data);
      if (myGen !== claimGen) return;
      // Founder directive (2026-07-28): the count-up ritual belongs on the
      // BALANCE now, old -> new, not on the reward amount again (that's
      // already been shown in full since the sheet opened — see
      // showClaimSheet above). Pre-claim balance comes from the
      // tokenStatus this sheet was opened with; if that's ever unavailable
      // animateCountUp itself falls back to just displaying the new
      // balance directly rather than animating from a guessed number.
      var preClaimBalance = claimOpts.tokenStatus && typeof claimOpts.tokenStatus.balance === 'number' ? claimOpts.tokenStatus.balance : null;
      if (typeof data.balance === 'number') {
        document.getElementById('claim-sheet-balance').style.display = 'block';
        animateCountUp(document.getElementById('claim-sheet-balance-num'), preClaimBalance, data.balance, 650);
      }
      fireConfetti();
      document.getElementById('claim-sheet-streak').textContent = 'Day ' + data.streak;
      label.textContent = 'Claimed!';
      setTimeout(function () {
        if (myGen !== claimGen) return;
        hideClaimSheet(true);
      }, 1100);
    }).catch(function (err) {
      if (myGen !== claimGen) return;
      btn.disabled = false;
      label.textContent = 'Claim ' + ((claimOpts.tokenStatus && claimOpts.tokenStatus.dailyClaimAmount) || 20) + ' tokens';
      errEl.textContent = claimErrorCopy(err);
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
  // Today that's only home.html (successUrl always points there — see
  // wireBuyButton above — since it's the one page that knows how to resume
  // a generation from an intact draft, formerly processing.html's job
  // before that page was removed, tracker item for-product-funnel-ending-
  // v2-founder-ins-tfuu0q); style.html/result.html only ever see
  // ?checkout=cancelled (their own cancelUrl points back at themselves).
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
    // `starter` mirrors dodo-webhook.js's own server-side Purchase event
    // (tracker item for-product-build-ship-today-founder-app-zn9zyy, item
    // 5) — read from the marker if present (every purchase made through
    // THIS sheet after this change stamps it, see wireBuyButton above),
    // falling back to a plain pack-id check for a marker created before
    // this field existed, rather than omitting the property outright.
    var starter = typeof pending.starter === 'boolean' ? pending.starter : pending.pack === STARTER_PACK_ID;
    var purchaseProps = { pack: pending.pack, tokens: pending.tokens, value: pending.price, currency: 'USD', starter: starter };
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
    PACK_ORDER: PACK_ORDER,
    STARTER_PACK_ID: STARTER_PACK_ID,
    PENDING_PURCHASE_KEY: PENDING_PURCHASE_KEY,
    LOW_BALANCE_THRESHOLD: LOW_BALANCE_THRESHOLD,
    // Exported so a caller that has to reason about the confirmation
    // window itself reads the same numbers pollForCredit already defaults
    // to, instead of restating them. shop.html's checkout-return banner
    // budgets its baseline-establishment retries and its poll out of ONE
    // shared window and needs them for that. A second, drifted copy of
    // exactly these two values is what produced the 15s-vs-75s bug this
    // whole confirmation path exists to fix.
    POLL_INTERVAL_MS: POLL_INTERVAL_MS,
    POLL_MAX_MS: POLL_MAX_MS,
    pickContextualPack: pickContextualPack,
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
    pollForCredit: pollForCredit,
    claimErrorCopy: claimErrorCopy
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
