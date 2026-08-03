// netlify/functions/lib/email-layout.js
//
// Shared HTML shell for this codebase's RETENTION/MARKETING emails only
// (tracker item for-product-email-redesign-unsubscribe-l-16ysmp, the
// "DESIGN" half — "elevate the templates toward the product night
// aesthetic... proper header/wordmark (M1 logo), night palette, cleaner
// typography, footer with unsubscribe + address"). Used by
// lib/first-dream-email-sender.js (the first-dream retention email) and
// dream-webhook.js (the abandoned-dream "your dream is ready" re-
// engagement email) — the same two senders this feature's Part 1 wires
// suppression/unsubscribe into (see lib/email-suppression-store.js's own
// header comment for why the scope is exactly these two, not every
// sender). A future win-back/weekly-recap send should reuse this too.
//
// DELIBERATE EXCEPTION to this codebase's own "small, self-contained
// per-file constants, not one shared module" convention (see lib/first-
// dream-email-sender.js's own header comment on why that convention
// exists for things like RESEND_API_BASE/FROM_ADDRESS): that convention
// is about trivial one-line values cheap enough to duplicate safely. A
// full visual shell — logo, dark card, footer copy, unsubscribe/address
// block — is a different kind of thing: it has to look IDENTICAL across
// every retention/marketing email for the brand redesign this task is
// actually about, and every future sender needs the exact same
// unsubscribe-link/mailing-address footer for the exact same legal reason
// (CAN-SPAM/GDPR). Duplicating that much HTML per file would mean a
// future copy/paste drifting the footer's legal text or the unsubscribe
// link's placement without anyone noticing — a real risk a shared shell
// removes cleanly for a small, deliberate cost in cross-file coupling.
//
// PLACEHOLDER MAILING ADDRESS (flagged explicitly in this build's own
// report — CAN-SPAM requires a real physical postal address in every
// marketing email's footer): MAILING_ADDRESS below is NOT real. Replace
// it with Ron's actual business/mailing address before this branch is
// approved for rollout.
//
// Inline CSS throughout (email clients don't support external
// stylesheets or many modern CSS features — no ::before/::after, no CSS
// variables, limited flexbox/grid support), and every color is an
// EXPLICIT hex value on both background and text (never relying on
// transparency/currentColor assumptions) so this renders correctly under
// clients that auto-invert for their own dark mode as well as ones that
// don't touch it at all — see this feature's own tracker item: "test
// that inline styles use explicit background/text colors rather than
// relying on transparency assumptions".
//
// Palette mirrors css/styles.css's own :root custom properties (an email
// can't read a shared stylesheet, so these are the same values,
// hardcoded) — --void/--bg-app (#000), --surface (#1a1a1a), --text-primary
// (#fff), --text-muted (#999), --text-faint (#666), --border
// (rgba(255,255,255,.08), approximated here as a solid low-contrast hex
// since some email clients handle low-alpha borders inconsistently). The
// card itself uses #151027 — the same near-black purple css/styles.css's
// own .vcard/night-surface treatments already use elsewhere in the app
// (see that file's own line using `linear-gradient(#151027,#151027)`) —
// rather than flat --surface, so the email reads as "this app's own
// night aesthetic" rather than a generic dark-mode card.
//
// CTA buttons match .btn-primary exactly (css/styles.css: "Plain
// white-fill / black-text — the app's one 'solid' button look") — solid
// white pill, black text, fully rounded — the one high-contrast button
// treatment this app actually uses, reused here rather than inventing a
// new email-only button style.

var COLORS = {
  void: '#000000',
  card: '#151027',
  surfaceAlt: '#1f1a33',
  textPrimary: '#ffffff',
  textMuted: '#a39fc2',
  textFaint: '#77719a',
  border: '#2a2540',
  ctaBg: '#ffffff',
  ctaText: '#000000'
};

// Flagged as a placeholder in this build's own report -- see header comment.
var MAILING_ADDRESS = 'DreamTube, Inc. · 548 Market St PMB 12345, San Francisco, CA 94104';

function esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** `x-forwarded-host || host`, this codebase's existing convention. */
function selfOrigin(event) {
  var headers = (event && event.headers) || {};
  var host = headers['x-forwarded-host'] || headers.host || '';
  return 'https://' + host;
}

function logoUrl(event) {
  return selfOrigin(event) + '/assets/logo-v4.png';
}

/**
 * Wraps `bodyHtml` (the sender's own per-email content — already-built
 * HTML, e.g. the media banner/thumbnail + CTA button + copy) in the
 * shared night-aesthetic shell: hidden preheader text, logo header, dark
 * card, and a footer carrying the required unsubscribe link + mailing
 * address. `opts`:
 *   event           (required) — for logoUrl/selfOrigin
 *   previewText     (optional) — short hidden preheader snippet most
 *                   inboxes show next to the subject line
 *   bodyHtml        (required) — the sender's own inner content
 *   unsubscribeUrl  (required for a marketing/retention send — see header
 *                   comment on scope) — rendered in the footer; omitting
 *                   it drops the whole footer block rather than ever
 *                   rendering a broken/empty unsubscribe link.
 */
function renderShell(opts) {
  opts = opts || {};
  var preheader = opts.previewText
    ? '<div style="display:none;max-height:0;overflow:hidden;opacity:0;mso-hide:all;">' + esc(opts.previewText) + '</div>'
    : '';

  var footer = opts.unsubscribeUrl
    ? (
      '<tr><td style="padding:20px 28px 28px;border-top:1px solid ' + COLORS.border + ';">' +
      '<p style="margin:16px 0 6px;font-size:12px;line-height:1.6;color:' + COLORS.textFaint + ';">' +
      'You\'re getting this because you have a DreamTube account. ' +
      '<a href="' + esc(opts.unsubscribeUrl) + '" style="color:' + COLORS.textMuted + ';text-decoration:underline;">Unsubscribe</a>' +
      '</p>' +
      '<p style="margin:0;font-size:11px;line-height:1.6;color:' + COLORS.textFaint + ';">' + esc(MAILING_ADDRESS) + '</p>' +
      '</td></tr>'
    )
    : '';

  return (
    '<div style="background:' + COLORS.void + ';padding:32px 16px;font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,sans-serif;">' +
    preheader +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;margin:0 auto;background:' + COLORS.card + ';border-radius:28px;border:1px solid ' + COLORS.border + ';overflow:hidden;">' +
    '<tr><td style="padding:26px 28px 8px;text-align:center;">' +
    '<img src="' + logoUrl(opts.event) + '" width="40" height="40" alt="DreamTube" style="display:inline-block;width:40px;height:40px;border-radius:12px;" />' +
    '</td></tr>' +
    '<tr><td style="padding:12px 28px 8px;color:' + COLORS.textPrimary + ';">' + opts.bodyHtml + '</td></tr>' +
    footer +
    '</table>' +
    '</div>'
  );
}

/** Matches css/styles.css's `.btn-primary` exactly (solid white pill, black text) -- the one high-contrast CTA treatment this app uses elsewhere, reused here rather than a new email-only style. */
function ctaButton(url, label) {
  return '<a href="' + esc(url) + '" style="display:inline-block;padding:14px 26px;background:' + COLORS.ctaBg + ';color:' + COLORS.ctaText + ';border-radius:100px;text-decoration:none;font-weight:700;font-size:14.5px;">' + esc(label) + '</a>';
}

module.exports = { COLORS, MAILING_ADDRESS, esc, selfOrigin, logoUrl, renderShell, ctaButton };
