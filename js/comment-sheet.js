// js/comment-sheet.js
//
// Comment bottom sheet — Social Layer v2 slice 2 ("comments" —
// docs/SOCIAL_LAYER_V2_DESIGN.md, tracker item
// for-product-build-social-layer-v2-direct-34047c, design doc's own state
// E). Mounted on BOTH u.html (each Dream Journal card's comment-count
// action / "View all N" / "Add a thought…" teaser) and explore.html
// (behind a new comment icon in the feed-action rail) — the design doc's
// own open decision #3 ("Comments on Explore rail too at MVP", recommended
// "yes — one component, one QA pass"; build followed that recommendation,
// but it's still flagged as founder-open in this feature's own PR — see
// that PR description). ONE shared component, exactly this app's existing
// share-sheet.js/report-sheet.js convention (see share-sheet.js's own
// header comment for why this codebase centralizes sheet behavior into one
// module rather than re-implementing it per page).
//
// Shared bottom-sheet plumbing (mount into #app, SheetDismiss.wire for
// tap-outside + drag-to-dismiss) — same .sheet-overlay/.sheet/.sheet-handle
// base every other sheet in this app uses.
//
// SCROLL SHAPE — deliberately a SINGLE scroll region, not a nested one
// (design doc QA checklist: "sheet max-height scroll, no nested scroll
// traps"). `.sheet` is ALREADY the app-wide scrolling container (css/
// styles.css: max-height:88dvh; overflow-y:auto) and js/sheet-dismiss.js's
// drag-to-dismiss gesture decides drag-vs-scroll by checking THAT SAME
// element's own `scrollTop`. Giving the comment LIST its own separate
// overflow:auto region (a second, nested scrollable area) would silently
// break that check — a downward swipe over an already-part-way-scrolled
// inner list would still read the OUTER `.sheet`'s scrollTop as 0 and
// hijack the gesture into a whole-sheet dismiss instead of scrolling the
// list. So the composer is a `position:sticky; bottom:0` child WITHIN
// `.sheet`'s own single scroll flow (see css/styles.css's `.cs-composer-wrap`)
// rather than a second independently-scrolling panel — the list and the
// composer share the exact same scroll container the sheet's own
// tap-outside/drag-dismiss already correctly reasons about, so nothing new
// needs to be taught to js/sheet-dismiss.js.
//
// XSS — every piece of user-supplied text (comment `text`, `handle`) goes
// through this file's own esc() before ever reaching innerHTML — see esc()'s
// own comment for why this is a LOCAL copy rather than a dependency on
// js/dream-cards.js's identical DreamCards.esc: explore.html (one of this
// component's two mount points) does not load dream-cards.js today, so this
// module must not assume it's present. Comments are this app's FIRST
// hostile-UGC text surface (design doc QA checklist: "esc() every user
// string ... XSS review mandatory") — this is the one thing in this file
// that must never regress.
//
// PER-INSTANCE TOKEN GUARD — the optimistic post/delete flows below bump
// `currentGen` on every show()/hide() and every async .then/.catch checks
// `myGen !== currentGen` before touching any DOM, same documented
// recurring-bug-class guard js/share-sheet.js's/js/report-sheet.js's own
// currentGen already use (see share-sheet.js's own header comment) — a
// stale response for a comment sheet the viewer has since closed (or
// reopened for a DIFFERENT dream) must never mutate DOM that no longer
// belongs to it.
//
// THREADING, one level deep (tracker item
// for-product-founder-go-08-07-add-threadi-zb3j26 — the founder-approved
// next increment after flat comments shipped). get-comments.js still
// returns one FLAT array (each comment carries `parentId`, null for
// top-level) — this file does the grouping at render time: `renderList`
// buckets `loadedComments` into top-level comments each followed by its own
// `.cs-replies` block, both levels kept in the SAME newest-first order the
// flat array already arrives in (filtering a newest-first array can't
// reorder what it keeps). A reply itself is never reply-able — `commentRowHTML`
// only renders the "Reply" action on a top-level row, and `startReply` only
// ever accepts a top-level comment id — this is the CLIENT half of the
// one-level-deep limit; add-comment.js independently enforces the same rule
// server-side (E12), since a hostile client could otherwise skip this file
// entirely. `replyTarget` (module state, reset in show()/hide() same as
// `loadedComments`) holds which top-level comment the composer is currently
// scoped to, null for a plain top-level post — see renderComposer()'s own
// comment for how that's surfaced in the composer UI, and submitComment()'s
// own comment for why a FAILED reply post deliberately does NOT clear it
// (so the user can retry without re-tapping Reply) while a successful one
// does. Deleting a top-level comment cascades to its replies — see
// deleteCommentAction's own comment for the client-side mirror of
// delete-comment.js's server-side cascade (same header comment there has
// the full "why cascade, not a [deleted] placeholder" reasoning).
// `commentCount`/the sheet's own "Comments · N" title count the WHOLE tree
// (top-level + replies), matching delete-comment.js's own commentCount
// SEMANTICS comment.
//
// Plain script (no ES modules — see CLAUDE.md), attaches
// window.CommentSheet.

(function () {
  'use strict';

  var SHEET_ID = 'comment-sheet-overlay';
  var current = null; // the opts object passed to the most recent show() call
  var currentGen = 0; // bumped on every show()/hide() -- see header comment
  var loadedComments = []; // FLAT, newest-first -- raw { id, handle, text, parentId, createdAt } records from get-comments.js (or an optimistic in-flight entry, see submitComment); renderList groups these into threads at render time, see this file's own THREADING header comment
  var loadReqSeq = 0; // guards against an in-flight get-comments fetch resolving after a newer load() call (e.g. rapid re-open) landed first
  var replyTarget = null; // the top-level comment {id,handle,...} the composer is currently scoped to reply to, or null for a plain top-level post -- reset in show()/hide(), see this file's own THREADING header comment

  var MAX_COMMENT_CHARS = 300;
  var COUNTER_WARN_AT = 250;
  var COMPOSER_MAX_HEIGHT_PX = 72; // ~3 lines at this component's own font-size/line-height, see .cs-composer-textarea

  /**
   * HTML-escapes a string for interpolation into markup. A deliberate LOCAL
   * copy of js/dream-cards.js's identical esc() (see that file's own doc
   * comment for the exact behavior/reasoning) rather than a dependency on
   * DreamCards being loaded -- explore.html, one of this component's two
   * mount points, does not load js/dream-cards.js. See this file's own
   * header comment for why this must never be skipped for comment
   * text/handles.
   */
  function esc(str) {
    return String(str == null ? '' : str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function stripAt(handle) {
    return (typeof handle === 'string') ? handle.replace(/^@/, '') : handle;
  }

  /** Compact relative-time label ("now"/"5m"/"3h"/"2d"/"6w"/"4mo"/"1y") -- no existing helper for this in the codebase (grep confirmed), so a small local one lives here rather than a new shared file for a single caller. */
  function timeAgo(iso) {
    var then = new Date(iso).getTime();
    if (isNaN(then)) return '';
    var diffSec = Math.max(0, Math.floor((Date.now() - then) / 1000));
    if (diffSec < 60) return 'now';
    var diffMin = Math.floor(diffSec / 60);
    if (diffMin < 60) return diffMin + 'm';
    var diffHr = Math.floor(diffMin / 60);
    if (diffHr < 24) return diffHr + 'h';
    var diffDay = Math.floor(diffHr / 24);
    if (diffDay < 7) return diffDay + 'd';
    var diffWeek = Math.floor(diffDay / 7);
    if (diffWeek < 5) return diffWeek + 'w';
    var diffMonth = Math.floor(diffDay / 30);
    if (diffMonth < 12) return diffMonth + 'mo';
    return Math.floor(diffDay / 365) + 'y';
  }

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
      '<div class="sheet comment-sheet">' +
      '  <div class="sheet-handle"></div>' +
      '  <div class="sheet-title" id="cs-title">Comments</div>' +
      '  <div id="cs-list"></div>' +
      '  <div class="cs-composer-wrap" id="cs-composer-wrap"></div>' +
      '</div>';
    host.appendChild(wrap);

    // Tap-outside + drag-to-dismiss — same shared wiring every other
    // .sheet-overlay in this app uses (js/sheet-dismiss.js). See this
    // file's own SCROLL SHAPE header comment for why `.sheet` stays the
    // single scroll container this drag gesture already knows how to read.
    SheetDismiss.wire(wrap, hide);

    document.getElementById('cs-list').addEventListener('click', onListClick);
    document.getElementById('cs-composer-wrap').addEventListener('click', onComposerClick);
    document.getElementById('cs-composer-wrap').addEventListener('input', onComposerInput);

    // Closes any open per-comment overflow menu on an outside click/tap --
    // same "outside" idea as js/sheet-dismiss.js's own tap-outside-to-close,
    // just scoped to the small dropdown rather than the whole sheet.
    document.addEventListener('click', function (e) {
      if (e.target.closest('.cs-overflow-wrap')) return;
      closeAllOverflowMenus();
    });
  }

  function closeAllOverflowMenus() {
    var el = document.getElementById(SHEET_ID);
    if (!el) return;
    Array.prototype.forEach.call(el.querySelectorAll('.cs-overflow-menu.open'), function (m) { m.classList.remove('open'); });
  }

  function myHandleLower() {
    return current && current.currentUser ? stripAt(current.currentUser.handle).toLowerCase() : null;
  }

  function isLoggedIn() {
    return !!(current && current.currentUser);
  }

  // ==========================================================================
  // Rendering
  // ==========================================================================

  /** isReply: true for a row rendered inside a `.cs-replies` block -- suppresses the "Reply" action (one-level-deep limit, see this file's own THREADING header comment) and lets CSS de-emphasize/indent it via `.cs-replies .cs-comment`. */
  function commentRowHTML(c, isReply) {
    var handle = stripAt(c.handle);
    var mine = myHandleLower() === handle.toLowerCase();
    var dreamOwnerHandle = current.dream && current.dream.ownerHandle;
    var isDreamOwner = isLoggedIn() && !!dreamOwnerHandle && myHandleLower() === stripAt(dreamOwnerHandle).toLowerCase();
    var canDelete = mine || isDreamOwner;
    var fallback = (window.DreamStore && DreamStore.avatarFallback) ? DreamStore.avatarFallback(c.handle) : { gradient: '#555', initial: '?' };

    var items = '';
    if (canDelete) items += '<button type="button" class="cs-overflow-item" data-action="delete">Delete</button>';
    if (!mine) {
      items += '<button type="button" class="cs-overflow-item" data-action="report">Report</button>';
      items += '<button type="button" class="cs-overflow-item" data-action="block">Block</button>';
    }

    // Reply action -- top-level rows only. Rendered even for a signed-out
    // viewer (same posture as the per-comment Block action above) so a tap
    // routes through onRequireLogin rather than the button simply vanishing.
    var replyBtn = isReply ? '' : '<button type="button" class="cs-reply-btn" data-reply-to="' + esc(c.id) + '">Reply</button>';

    return '<div class="cs-comment" data-comment-id="' + esc(c.id) + '">' +
      '<div class="cs-avatar" style="background:' + fallback.gradient + '">' + esc(fallback.initial) + '</div>' +
      '<div class="cs-body">' +
        '<div class="cs-meta">' +
          '<span class="cs-handle" data-goto-handle="' + esc(handle) + '">@' + esc(handle) + '</span>' +
          '<span class="cs-time">' + esc(timeAgo(c.createdAt)) + '</span>' +
        '</div>' +
        '<div class="cs-text" dir="auto">' + esc(c.text) + '</div>' +
        replyBtn +
      '</div>' +
      (items ? (
        '<div class="cs-overflow-wrap">' +
          '<button type="button" class="cs-overflow-btn" data-overflow-toggle aria-label="More options">' + (window.Icons ? Icons.moreHorizontal : '&#8942;') + '</button>' +
          '<div class="cs-overflow-menu" id="cs-overflow-' + esc(c.id) + '">' + items + '</div>' +
        '</div>'
      ) : '') +
    '</div>';
  }

  /** Builds one `.cs-thread` — a top-level comment plus its own `.cs-replies` block (empty when it has none). See this file's own THREADING header comment for the grouping/ordering rules. */
  function threadHTML(topLevelComment) {
    var replies = loadedComments.filter(function (r) { return r.parentId === topLevelComment.id; });
    var repliesHTML = replies.length
      ? ('<div class="cs-replies">' + replies.map(function (r) { return commentRowHTML(r, true); }).join('') + '</div>')
      : '';
    return '<div class="cs-thread" data-thread-id="' + esc(topLevelComment.id) + '">' + commentRowHTML(topLevelComment, false) + repliesHTML + '</div>';
  }

  function renderList() {
    var listEl = document.getElementById('cs-list');
    if (!current) return;
    if (!loadedComments.length) {
      listEl.innerHTML = '<div class="cs-empty" id="cs-empty">No thoughts yet — be the first.</div>';
    } else {
      var topLevel = loadedComments.filter(function (c) { return !c.parentId; });
      listEl.innerHTML = topLevel.map(threadHTML).join('');
    }
    // Total tree size (top-level + replies) -- see this file's own
    // THREADING header comment for why replies count toward this badge too.
    document.getElementById('cs-title').textContent = 'Comments · ' + loadedComments.length;
  }

  function renderComposer() {
    var wrap = document.getElementById('cs-composer-wrap');
    if (isLoggedIn()) {
      // Reply-scoped context banner (see this file's own THREADING header
      // comment) -- absent entirely for a plain top-level post, which is
      // also how a fresh show()/hide() and a successful reply post both
      // return to this same plain state (replyTarget reset to null first).
      var replyBanner = replyTarget
        ? ('<div class="cs-reply-context" id="cs-reply-context">Replying to <b>@' + esc(stripAt(replyTarget.handle)) + '</b>' +
           '<button type="button" class="cs-reply-cancel" id="cs-reply-cancel" aria-label="Cancel reply">&times;</button></div>')
        : '';
      var placeholder = replyTarget ? ('Reply to @' + stripAt(replyTarget.handle) + '…') : 'Add a thought…';
      wrap.innerHTML =
        replyBanner +
        '<div class="cs-composer-row">' +
        '  <textarea class="cs-composer-textarea" id="cs-composer-textarea" dir="auto" rows="1" maxlength="' + MAX_COMMENT_CHARS + '" placeholder="' + esc(placeholder) + '"></textarea>' +
        '  <button type="button" class="cs-composer-post" id="cs-composer-post" disabled>Post</button>' +
        '</div>' +
        '<div class="cs-composer-counter" id="cs-composer-counter">0/' + MAX_COMMENT_CHARS + '</div>';
    } else {
      // Signed-out: composer row replaced entirely -- design doc state E.
      // Reuses the SAME signup-nudge modal every other signed-out gated
      // action in this app already opens (explore.html's like/+Create/
      // Profile taps, u.html's own like handler) via the caller-supplied
      // onRequireLogin -- this module never renders its own modal.
      wrap.innerHTML = '<div class="cs-login-row" id="cs-login-row">Log in to comment</div>';
    }
  }

  function updateCounter() {
    var textarea = document.getElementById('cs-composer-textarea');
    var counter = document.getElementById('cs-composer-counter');
    var postBtn = document.getElementById('cs-composer-post');
    if (!textarea || !counter || !postBtn) return;
    var len = textarea.value.length;
    counter.textContent = len + '/' + MAX_COMMENT_CHARS;
    counter.classList.toggle('warn', len >= COUNTER_WARN_AT);
    postBtn.disabled = textarea.value.trim().length === 0 || len > MAX_COMMENT_CHARS;
  }

  function autoGrow(textarea) {
    textarea.style.height = 'auto';
    var next = Math.min(textarea.scrollHeight, COMPOSER_MAX_HEIGHT_PX);
    textarea.style.height = next + 'px';
    textarea.style.overflowY = textarea.scrollHeight > COMPOSER_MAX_HEIGHT_PX ? 'auto' : 'hidden';
  }

  // ==========================================================================
  // Load
  // ==========================================================================

  function load() {
    var listEl = document.getElementById('cs-list');
    listEl.innerHTML = '<div class="cs-empty">Loading…</div>';
    var dreamId = current.dream.id;
    var myGen = currentGen;
    var myReq = ++loadReqSeq;

    fetch('/.netlify/functions/get-comments?dreamId=' + encodeURIComponent(dreamId))
      .then(function (res) { return res.json(); })
      .then(function (data) {
        if (myGen !== currentGen || myReq !== loadReqSeq) return; // sheet dismissed/reopened (for this or a different dream) meanwhile -- abandoned, no-op
        if (!data || data.error) throw new Error((data && data.error) || 'unknown_error');
        var blocked = (window.DreamStore && typeof DreamStore.getBlockedHandles === 'function') ? DreamStore.getBlockedHandles() : [];
        // Client-side block filtering (design doc's own Data/API line:
        // "Block: client hides comments from getBlockedHandles()") --
        // mirrors explore.html's own d.blockedByMe filtering pattern
        // (drop the entry entirely, don't just flag it).
        loadedComments = (data.comments || []).filter(function (c) { return blocked.indexOf(c.handle) === -1; });
        renderList();
      })
      .catch(function () {
        if (myGen !== currentGen || myReq !== loadReqSeq) return;
        loadedComments = [];
        listEl.innerHTML = '<div class="cs-empty">Couldn\'t load comments — <span class="link-text" id="cs-retry">try again</span></div>';
        var retry = document.getElementById('cs-retry');
        if (retry) retry.addEventListener('click', load);
      });
  }

  // ==========================================================================
  // show / hide
  // ==========================================================================

  /**
   * opts:
   *   dream         — { id, ownerHandle } at minimum (whatever the caller's
   *                   own in-memory dream record looks like).
   *   currentUser   — DreamStore.getCurrentUser()'s own return shape
   *                   ({ handle, username, authToken }) or null/undefined
   *                   when signed out.
   *   onRequireLogin() — called instead of posting/blocking when signed out.
   *   onToast(msg)  — optional, the caller's own showToast.
   *   onCountChange(dreamId, newCount) — optional, called after a
   *                   successful post/delete so the caller can update its
   *                   own already-rendered comment-count badge without
   *                   waiting for a full reload.
   */
  function show(opts) {
    opts = opts || {};
    ensureMounted();
    current = opts;
    currentGen++;
    loadedComments = [];
    replyTarget = null;
    closeAllOverflowMenus();
    renderComposer();
    renderList();
    document.getElementById(SHEET_ID).classList.add('open');
    trackLocal('comment_sheet_opened', { dreamId: opts.dream && opts.dream.id });
    load();
  }

  function hide() {
    var el = document.getElementById(SHEET_ID);
    if (el) el.classList.remove('open');
    current = null;
    currentGen++;
    replyTarget = null;
    closeAllOverflowMenus();
  }

  // ==========================================================================
  // Post
  // ==========================================================================

  function submitComment() {
    if (!current || !isLoggedIn()) return;
    var textarea = document.getElementById('cs-composer-textarea');
    var text = textarea.value.trim();
    if (!text || text.length > MAX_COMMENT_CHARS) return;

    var dream = current.dream;
    var user = current.currentUser;
    var myGen = currentGen;
    // Captured now, not read fresh inside the .then/.catch below -- if the
    // user cancels/switches reply target while THIS request is still in
    // flight, this submit's own outcome must only ever affect ITS OWN reply
    // context, never whatever replyTarget happens to be by the time the
    // response lands (same per-instance-guard spirit as currentGen, just on
    // the composer's reply-scope axis instead of the whole sheet's).
    var myReplyTarget = replyTarget;
    var parentId = myReplyTarget ? myReplyTarget.id : null;
    var postBtn = document.getElementById('cs-composer-post');
    if (postBtn) postBtn.disabled = true;

    // Optimistic insert at the top (newest-first) -- rolled back on
    // failure, same "flip immediately, reconcile or roll back" pattern
    // u.html's/explore.html's own like handlers already use. Unshifting is
    // still correct for a reply: renderList/threadHTML group by parentId
    // via Array.filter, which preserves relative order, so a reply placed
    // at the front of the flat array still lands at the front of ITS OWN
    // parent's `.cs-replies` slice -- it never "jumps" into the top-level
    // list just because it's now array index 0.
    var optimisticId = 'optimistic-' + Date.now() + '-' + Math.random().toString(36).slice(2);
    var optimisticComment = { id: optimisticId, handle: user.handle, text: text, parentId: parentId, createdAt: new Date().toISOString() };
    loadedComments.unshift(optimisticComment);
    renderList();
    textarea.value = '';
    autoGrow(textarea);
    updateCounter();

    fetch('/.netlify/functions/add-comment', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dreamId: dream.id, handle: user.handle, authToken: user.authToken, text: text, parentId: parentId })
    }).then(function (res) {
      return res.json().then(function (data) { return { ok: res.ok, data: data }; });
    }).then(function (result) {
      if (myGen !== currentGen) return; // sheet dismissed/reopened meanwhile -- see header comment
      if (!result.ok || (result.data && result.data.ok === false)) throw new Error((result.data && result.data.error) || 'add_comment_failed');
      var idx = loadedComments.findIndex(function (c) { return c.id === optimisticId; });
      if (idx !== -1) loadedComments[idx] = result.data.comment;
      renderList();
      trackLocal('comment_posted', { dreamId: dream.id, isReply: !!parentId });
      if (typeof current.onCountChange === 'function') {
        current.onCountChange(dream.id, result.data.commentCount != null ? result.data.commentCount : loadedComments.length);
      }
      // Exit reply mode on SUCCESS, but only if the composer is still
      // scoped to THIS SAME reply target -- see this function's own comment
      // on myReplyTarget above for why a stale success must not clobber a
      // reply-target the user has since changed.
      if (replyTarget && myReplyTarget && replyTarget.id === myReplyTarget.id) {
        replyTarget = null;
        renderComposer();
      }
    }).catch(function () {
      if (myGen !== currentGen) return; // see header comment
      loadedComments = loadedComments.filter(function (c) { return c.id !== optimisticId; });
      renderList();
      if (typeof current.onToast === 'function') current.onToast("Couldn't post your comment — try again.");
      // Deliberately does NOT clear replyTarget on failure -- see this
      // function's own comment above: the user should be able to retry the
      // same reply without re-tapping Reply.
    });
  }

  // ==========================================================================
  // Delete
  // ==========================================================================

  /**
   * Deleting a TOP-LEVEL comment cascades to its replies client-side too --
   * mirrors delete-comment.js's own server-side cascade exactly (see that
   * file's own CASCADE DELETE ON REPLIES header comment for the full "why"
   * cascade-delete rather than a "[deleted]" placeholder that preserves
   * replies). Deleting a REPLY removes only that one row, same as any
   * single comment delete before threading existed.
   */
  function deleteCommentAction(commentId) {
    if (!current || !isLoggedIn()) return;
    var dream = current.dream;
    var user = current.currentUser;
    var myGen = currentGen;

    var target = loadedComments.filter(function (c) { return c.id === commentId; })[0];
    if (!target) return;

    var idsToRemove = [commentId];
    if (!target.parentId) {
      loadedComments.forEach(function (c) { if (c.parentId === commentId) idsToRemove.push(c.id); });
    }
    var idSet = {};
    idsToRemove.forEach(function (id) { idSet[id] = true; });

    // Snapshot each removed row's ORIGINAL index (ascending) so a failed
    // delete can splice everything back into its exact original position --
    // same "splice back in at removedIndex" rollback the single-comment
    // case always used, just extended to possibly more than one row.
    // Reinserting lowest-original-index first is what makes this correct
    // for multiple ids: once an earlier index is restored, the array's
    // prefix up to the next removed index again matches the original
    // array exactly, so that index is still the right splice point.
    var removedEntries = [];
    loadedComments.forEach(function (c, idx) { if (idSet[c.id]) removedEntries.push({ index: idx, comment: c }); });

    loadedComments = loadedComments.filter(function (c) { return !idSet[c.id]; });
    renderList();

    fetch('/.netlify/functions/delete-comment', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dreamId: dream.id, commentId: commentId, authToken: user.authToken })
    }).then(function (res) {
      return res.json().then(function (data) { return { ok: res.ok, data: data }; });
    }).then(function (result) {
      if (myGen !== currentGen) return; // see header comment
      if (!result.ok || (result.data && result.data.ok === false)) throw new Error((result.data && result.data.error) || 'delete_comment_failed');
      trackLocal('comment_deleted', { dreamId: dream.id, cascaded: idsToRemove.length > 1 });
      if (typeof current.onCountChange === 'function') {
        current.onCountChange(dream.id, result.data.commentCount != null ? result.data.commentCount : loadedComments.length);
      }
      if (typeof current.onToast === 'function') current.onToast(idsToRemove.length > 1 ? 'Comment and its replies deleted' : 'Comment deleted');
    }).catch(function () {
      if (myGen !== currentGen) return; // see header comment
      // Roll back -- reinsert every removed row at its ORIGINAL index (see
      // this function's own comment on removedEntries above for ordering).
      removedEntries.forEach(function (entry) { loadedComments.splice(entry.index, 0, entry.comment); });
      renderList();
      if (typeof current.onToast === 'function') current.onToast("Couldn't delete — try again.");
    });
  }

  // ==========================================================================
  // Report (per-comment) — immediate, single-tap, no reason form. Unlike
  // js/report-sheet.js's own "Report this dream" flow (which expands into a
  // free-text-reason form before submitting), a per-comment overflow item is
  // a small, dense menu where a second full-form step would be
  // disproportionate to how quick a "this one line is bad" report should
  // be -- same minimal-friction posture js/report-sheet.js's own Block
  // option already takes (no confirmation step either). Anonymous-friendly,
  // matching report-dream.js's own posture (no login required to file one).
  // ==========================================================================

  function reportCommentAction(comment) {
    if (!current) return;
    var dream = current.dream;
    var myGen = currentGen;
    fetch('/.netlify/functions/report-dream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        dreamId: dream.id,
        dreamOwnerHandle: dream.ownerHandle || null,
        targetType: 'comment',
        commentId: comment.id,
        commentText: comment.text,
        commentAuthorHandle: comment.handle,
        reporterHandle: current.currentUser ? current.currentUser.handle : null,
        reason: null
      })
    }).then(function (res) { return res.json().then(function (data) { return { ok: res.ok, data: data }; }); })
      .then(function (result) {
        if (myGen !== currentGen) return; // see header comment
        if (!result.ok) throw new Error((result.data && result.data.error) || 'report_failed');
        trackLocal('comment_reported', { dreamId: dream.id, commentId: comment.id });
        if (typeof current.onToast === 'function') current.onToast('Reported — thanks for letting us know');
      }).catch(function () {
        if (myGen !== currentGen) return; // see header comment
        if (typeof current.onToast === 'function') current.onToast("Couldn't submit your report — try again.");
      });
  }

  // ==========================================================================
  // Block (per-comment author) — same immediate, no-confirm shape as
  // js/report-sheet.js's own chooseBlock, applied to the comment's author
  // instead of a dream's owner.
  // ==========================================================================

  function blockCommentAuthorAction(handle) {
    if (!current) return;
    if (!isLoggedIn()) {
      if (typeof current.onRequireLogin === 'function') current.onRequireLogin();
      return;
    }
    trackLocal('user_blocked', { blockedHandle: handle, source: 'comment_sheet' });
    if (window.DreamStore && typeof DreamStore.blockUser === 'function') DreamStore.blockUser(handle);
    loadedComments = loadedComments.filter(function (c) { return c.handle !== handle; });
    renderList();
    var displayName = (window.DreamStore && DreamStore.displayHandle) ? DreamStore.displayHandle(handle) : stripAt(handle);
    if (typeof current.onToast === 'function') current.onToast('Blocked ' + displayName + " — you won't see their comments anymore");
  }

  // ==========================================================================
  // Reply (composer scoping) — see this file's own THREADING header comment
  // ==========================================================================

  function startReply(commentId) {
    if (!current) return;
    if (!isLoggedIn()) {
      // Same posture as blockCommentAuthorAction above -- Reply is rendered
      // even signed-out (see commentRowHTML's own comment), so a tap routes
      // to the caller's signup nudge instead of scoping a composer that, in
      // the signed-out state, doesn't even render (renderComposer's login row).
      if (typeof current.onRequireLogin === 'function') current.onRequireLogin();
      return;
    }
    // Only a genuinely top-level comment can be a reply target -- defensive
    // guard matching the server's own E12, even though commentRowHTML never
    // renders a Reply button on a reply row in the first place.
    var comment = loadedComments.filter(function (c) { return c.id === commentId && !c.parentId; })[0];
    if (!comment) return;
    replyTarget = comment;
    renderComposer();
    var textarea = document.getElementById('cs-composer-textarea');
    if (textarea) textarea.focus();
  }

  function cancelReply() {
    replyTarget = null;
    renderComposer();
  }

  // ==========================================================================
  // Event delegation
  // ==========================================================================

  function onListClick(e) {
    if (!current) return;

    var gotoEl = e.target.closest('[data-goto-handle]');
    if (gotoEl) {
      location.href = 'u.html?handle=' + encodeURIComponent(gotoEl.dataset.gotoHandle);
      return;
    }

    var replyEl = e.target.closest('[data-reply-to]');
    if (replyEl) {
      startReply(replyEl.dataset.replyTo);
      return;
    }

    var toggleEl = e.target.closest('[data-overflow-toggle]');
    if (toggleEl) {
      var wrapEl = toggleEl.closest('.cs-overflow-wrap');
      var menu = wrapEl.querySelector('.cs-overflow-menu');
      var wasOpen = menu.classList.contains('open');
      closeAllOverflowMenus();
      if (!wasOpen) menu.classList.add('open');
      return;
    }

    var actionEl = e.target.closest('.cs-overflow-item');
    if (actionEl) {
      var rowEl = actionEl.closest('.cs-comment');
      var commentId = rowEl && rowEl.dataset.commentId;
      var comment = loadedComments.filter(function (c) { return c.id === commentId; })[0];
      closeAllOverflowMenus();
      if (!comment) return;
      if (actionEl.dataset.action === 'delete') deleteCommentAction(comment.id);
      else if (actionEl.dataset.action === 'report') reportCommentAction(comment);
      else if (actionEl.dataset.action === 'block') blockCommentAuthorAction(comment.handle);
      return;
    }
  }

  function onComposerClick(e) {
    if (!current) return;
    if (e.target.closest('#cs-login-row')) {
      if (typeof current.onRequireLogin === 'function') current.onRequireLogin();
      return;
    }
    if (e.target.closest('#cs-reply-cancel')) {
      cancelReply();
      return;
    }
    if (e.target.closest('#cs-composer-post')) {
      submitComment();
    }
  }

  function onComposerInput(e) {
    if (!e.target.closest('#cs-composer-textarea')) return;
    autoGrow(e.target);
    updateCounter();
  }

  var CommentSheet = { show: show, hide: hide };

  if (typeof window !== 'undefined') window.CommentSheet = CommentSheet;
  if (typeof module !== 'undefined' && module.exports) module.exports = CommentSheet;
})();
