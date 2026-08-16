// js/email-click-track.js
//
// First-party "email link was clicked" tracking. Founder ask 2026-08-16:
// clicks on email CTA links were not measurable anywhere in our own analytics
// (no click event, no UTM; the Resend webhook only catches bounces), so the
// only click data lived in Resend's dashboard. This closes that gap.
//
// HOW IT WORKS: every email's primary CTA appends `?ec=<email_type>` to its
// link (see the *-email-sender.js files). Direct-link emails (interp-none /
// interp-unread → result.html, verification → its page) carry it straight;
// the one-tap login emails (recovery nudge, winback) route through
// netlify/functions/email-login.js, which forwards `ec` onto its final
// redirect. Whichever page the click lands on loads this script, which turns
// that param into a single `email_link_clicked` PostHog event and then strips
// `ec` from the URL so a refresh or reshare can't double-count.
//
// No build step / no ES modules (see CLAUDE.md): a plain IIFE. Its only
// dependency is window.posthog (loaded on every page that includes this);
// it polls briefly for posthog rather than assuming load order, and no-ops
// instantly when there is no `ec` param — the overwhelmingly common case.
(function () {
  'use strict';
  if (typeof window === 'undefined' || !window.location) return;
  try {
    var params = new URLSearchParams(window.location.search);
    var ec = params.get('ec');
    if (!ec) return; // ordinary (non-email) page load — do nothing

    // Keep the event value bounded/clean — it's a known small set of email
    // types, never free text; guard against anything odd in the URL.
    var emailType = String(ec).slice(0, 40);

    function fire() {
      if (window.posthog && typeof window.posthog.capture === 'function') {
        try {
          window.posthog.capture('email_link_clicked', {
            email_type: emailType,
            dest: window.location.pathname
          });
        } catch (e) { /* analytics must never break the page */ }
        return true;
      }
      return false;
    }

    // posthog may not have finished initializing yet; poll briefly (up to ~4s),
    // then give up silently.
    if (!fire()) {
      var tries = 0;
      var timer = setInterval(function () {
        if (fire() || ++tries > 40) clearInterval(timer);
      }, 100);
    }

    // Strip `ec` from the URL so a reload / bookmark / reshare doesn't re-fire.
    params.delete('ec');
    var rest = params.toString();
    if (window.history && window.history.replaceState) {
      window.history.replaceState(null, '',
        window.location.pathname + (rest ? '?' + rest : '') + window.location.hash);
    }
  } catch (e) { /* never break the page for analytics */ }
})();
