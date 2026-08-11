// netlify/functions/lib/email-layout.js
//
// Shared HTML shell for this codebase's RETENTION/MARKETING emails only
// (tracker item for-product-email-redesign-unsubscribe-l-16ysmp, the
// "DESIGN" half &mdash; "elevate the templates toward the product night
// aesthetic... proper header/wordmark (M1 logo), night palette, cleaner
// typography, footer with unsubscribe + address"). Used by
// lib/first-dream-email-sender.js (the first-dream retention email) and
// dream-webhook.js (the abandoned-dream "your dream is ready" re-
// engagement email) &mdash; the same two senders this feature's Part 1 wires
// suppression/unsubscribe into (see lib/email-suppression-store.js's own
// header comment for why the scope is exactly these two, not every
// sender). A future win-back/weekly-recap send should reuse this too.
//
// DELIBERATE EXCEPTION to this codebase's own "small, self-contained
// per-file constants, not one shared module" convention (see lib/first-
// dream-email-sender.js's own header comment on why that convention
// exists for things like RESEND_API_BASE/FROM_ADDRESS): that convention
// is about trivial one-line values cheap enough to duplicate safely. A
// full visual shell &mdash; logo, dark card, footer copy, unsubscribe/address
// block &mdash; is a different kind of thing: it has to look IDENTICAL across
// every retention/marketing email for the brand redesign this task is
// actually about, and every future sender needs the exact same
// unsubscribe-link/mailing-address footer for the exact same legal reason
// (CAN-SPAM/GDPR). Duplicating that much HTML per file would mean a
// future copy/paste drifting the footer's legal text or the unsubscribe
// link's placement without anyone noticing &mdash; a real risk a shared shell
// removes cleanly for a small, deliberate cost in cross-file coupling.
//
// MAILING ADDRESS (CAN-SPAM requires a real physical postal address in
// every marketing email's footer): MAILING_ADDRESS below is the founder's
// own real address, supplied verbatim (tracker item
// for-product-email-redesign-unsubscribe-l-16ysmp, 2026-08-03 final
// clarification) &mdash; this used to be a flagged placeholder pending his
// answer; it no longer is. Rendered as small/faint as this file's own
// renderShell can make it while staying legible (his own explicit ask &mdash;
// "as small and as faint-colored as possible while staying readable/
// compliant") &mdash; see ADDRESS_COLOR below, a step fainter than this file's
// existing COLORS.textFaint (used for the unsubscribe line right above
// it, which stays at the more legible weight since THAT line carries the
// actual actionable link).
//
// Inline CSS throughout (email clients don't support external
// stylesheets or many modern CSS features &mdash; no ::before/::after, no CSS
// variables, limited flexbox/grid support), and every color is an
// EXPLICIT hex value on both background and text (never relying on
// transparency/currentColor assumptions) so this renders correctly under
// clients that auto-invert for their own dark mode as well as ones that
// don't touch it at all &mdash; see this feature's own tracker item: "test
// that inline styles use explicit background/text colors rather than
// relying on transparency assumptions".
//
// Palette mirrors css/styles.css's own :root custom properties (an email
// can't read a shared stylesheet, so these are the same values,
// hardcoded) &mdash; --void/--bg-app (#000), --surface (#1a1a1a), --text-primary
// (#fff), --text-muted (#999), --text-faint (#666), --border
// (rgba(255,255,255,.08), approximated here as a solid low-contrast hex
// since some email clients handle low-alpha borders inconsistently). The
// card itself uses #151027 &mdash; the same near-black purple css/styles.css's
// own .vcard/night-surface treatments already use elsewhere in the app
// (see that file's own line using `linear-gradient(#151027,#151027)`) &mdash;
// rather than flat --surface, so the email reads as "this app's own
// night aesthetic" rather than a generic dark-mode card.
//
// CTA buttons match .btn-primary exactly (css/styles.css: "Plain
// white-fill / black-text &mdash; the app's one 'solid' button look") &mdash; solid
// white pill, black text, fully rounded &mdash; the one high-contrast button
// treatment this app actually uses, reused here rather than inventing a
// new email-only button style.

var siteOrigin = require('./site-origin');

var COLORS = {
  void: '#000000',
  card: '#151027',
  textPrimary: '#ffffff',
  textMuted: '#a39fc2',
  textFaint: '#77719a',
  border: '#2a2540',
  ctaBg: '#ffffff',
  ctaText: '#000000'
};

// A step fainter than COLORS.textFaint, purely for the mailing-address
// line -- see header comment's MAILING ADDRESS paragraph on why this
// exists as its own constant rather than reusing textFaint (the
// unsubscribe line right above the address stays at the more legible
// textFaint, since it carries the actual actionable link). Still a real,
// distinguishable hex against COLORS.card (#151027), not blended all the
// way to invisible -- "as faint as possible while staying readable" per
// the founder's own explicit ask, not "as faint as possible" alone.
var ADDRESS_COLOR = '#48436a';

// The visible unsubscribe footer's dedicated small/faint style (founder
// request 2026-08-10, the "unwatched dream" retention-nudge round: "small
// faint font"). One step fainter than body text and smaller than it, but
// deliberately NOT as faint as ADDRESS_COLOR above -- this line still
// carries the one actionable footer LINK (the unsubscribe itself), so it
// stays legible/clickable, just quiet. Applies to every email using this
// shared shell. UNSUBSCRIBE_FONT_SIZE is smaller than the old 12px the
// footer used; the link now sits at COLORS.textFaint (a step down from the
// brighter COLORS.textMuted it used before) so it no longer reads as the
// most prominent thing in the footer.
var UNSUBSCRIBE_FONT_SIZE = '11px';
var UNSUBSCRIBE_LINK_COLOR = COLORS.textFaint;

var MAILING_ADDRESS = '10 Dgania, Herzliya, Israel';

function esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * This app's own public origin. Delegates to lib/site-origin.js's
 * emailOrigin -- see that file's header comment. This used to be a local
 * `'https://' + (x-forwarded-host || host || '')`, which produced the bare
 * string `'https://'` under a SCHEDULED invocation (no inbound request, so
 * no Host to reconstruct) and made logoUrl below emit
 * `https:///assets/logo-v4.png` -- a url that resolves to the nonexistent
 * host `assets`, so the 40x40 logo <img> rendered as a 40x40 BLANK SQUARE
 * in real founder-received emails (tracker item
 * for-product-bug-two-blank-square-emails--3fvxvc).
 */
function selfOrigin(event) {
  return siteOrigin.emailOrigin(event);
}

function logoUrl(event) {
  return selfOrigin(event) + '/assets/logo-v4.png';
}

// A tasteful, on-brand interpretation-themed still (the committed
// `assets/chamber-sage.jpg`, served on the canonical origin) used as the
// media-banner FALLBACK when a specific email has no per-recipient dream
// thumbnail to show (e.g. a dream whose first-frame still never synced, or
// a preview send with no real recipient dream). Absolute-origin resolved so
// it loads from any inbox, never a broken relative src.
var BRANDED_FALLBACK_IMAGE_PATH = '/assets/chamber-sage.jpg';
function brandedFallbackImageUrl(event) {
  return selfOrigin(event) + BRANDED_FALLBACK_IMAGE_PATH;
}

/**
 * Wraps `bodyHtml` (the sender's own per-email content &mdash; already-built
 * HTML, e.g. the media banner/thumbnail + CTA button + copy) in the
 * shared night-aesthetic shell: hidden preheader text, logo header, dark
 * card, and a footer carrying the required unsubscribe link + mailing
 * address. `opts`:
 *   event           (required) &mdash; for logoUrl/selfOrigin
 *   previewText     (optional) &mdash; short hidden preheader snippet most
 *                   inboxes show next to the subject line
 *   bodyHtml        (required) &mdash; the sender's own inner content
 *   unsubscribeUrl  (required for a marketing/retention send &mdash; see header
 *                   comment on scope) &mdash; rendered in the footer; omitting
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
      // Small + faint, one quiet line -- see UNSUBSCRIBE_FONT_SIZE/
      // UNSUBSCRIBE_LINK_COLOR above (founder "small faint font" request).
      '<p style="margin:16px 0 6px;font-size:' + UNSUBSCRIBE_FONT_SIZE + ';line-height:1.6;color:' + COLORS.textFaint + ';">' +
      'You\'re getting this because you have a DreamTube account. ' +
      '<a href="' + esc(opts.unsubscribeUrl) + '" style="color:' + UNSUBSCRIBE_LINK_COLOR + ';text-decoration:underline;">Unsubscribe</a>' +
      '</p>' +
      '<p style="margin:0;font-size:10px;line-height:1.5;color:' + ADDRESS_COLOR + ';">' + esc(MAILING_ADDRESS) + '</p>' +
      '</td></tr>'
    )
    : '';

  return (
    '<meta charset="utf-8">' +
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

/**
 * A rounded, full-width media banner `<img>` for the top of a retention/
 * marketing email body -- the recipient's own dream still where one exists,
 * else a branded fallback (see each sender's own image resolution). Same
 * inline-style shape lib/unwatched-dream-nudge-sender.js already used inline;
 * centralized here so every sender's thumbnail renders identically and an
 * email client that blocks images still degrades to the alt text, never a
 * broken layout. Requires an ABSOLUTE https:// url (an email client can't
 * load a relative one) -- returns '' for a missing/relative url rather than
 * ever emitting a broken <img>.
 */
function mediaImage(absoluteUrl, alt) {
  if (typeof absoluteUrl !== 'string' || !/^https?:\/\//i.test(absoluteUrl)) return '';
  return '<img src="' + esc(absoluteUrl) + '" width="480" alt="' + esc(alt || '') + '" style="display:block;width:100%;max-width:480px;height:180px;object-fit:cover;border-radius:14px;margin-bottom:18px;" />';
}

module.exports = { COLORS, ADDRESS_COLOR, MAILING_ADDRESS, UNSUBSCRIBE_FONT_SIZE, UNSUBSCRIBE_LINK_COLOR, esc, selfOrigin, logoUrl, brandedFallbackImageUrl, renderShell, ctaButton, mediaImage };
