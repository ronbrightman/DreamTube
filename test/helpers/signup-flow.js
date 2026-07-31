// test/helpers/signup-flow.js
//
// Shared Playwright interaction helpers for start.html's screen 13 — the
// unified signup screen (docs/SIGNUP_FACEBOOK_LOGIN_SPEC.md, tracker items
// for-product-signup-screen-the-single-big-bkwhbe and
// for-product-priority-founder-2026-07-30--ruzc5u). The 2026-07-30 CRO
// rebuild retired the old 50/50 signup_email_first_variant A/B test
// ('a' = password shown immediately, 'b' = email-first) in favor of a
// single design (the former 'b' arm, permanently) — every test that used
// to call a local pinSignupControlVariant() helper to force variant 'a' for
// a simpler one-step fill now goes through the real two-step interaction
// via the helpers below instead. There is no variant to pin anymore: this
// IS the only screen 13.
//
// Two-step interaction, matching renderScreen13EmailFirst's own
// renderEmailStep <-> renderPasswordStep DOM swap:
//   1. Fill #fn-email, click #fn-s13-email-continue -- reveals the
//      password step in place (no navigation).
//   2. Fill #fn-password, click #fn-s13-continue -- the real submission,
//      unchanged from before this rebuild (attemptSignup, both
//      signupAttemptToken guard layers, etc.).

/**
 * Fills the email field and advances to the password step. Waits for
 * #fn-password to actually appear (the in-screen DOM swap, not a
 * navigation) before returning, so callers can immediately interact with
 * the password field without a race.
 */
async function advanceToPasswordStep(page, email) {
  await page.waitForSelector('#fn-email', { timeout: 5000 });
  await page.fill('#fn-email', email);
  await page.click('#fn-s13-email-continue');
  await page.waitForSelector('#fn-password', { timeout: 5000 });
}

/**
 * Full two-step signup interaction: email step -> password step -> submit.
 * Does NOT wait for the submission's own outcome (screen 14, an inline
 * error, etc.) — callers assert on whatever they're each specifically
 * testing, exactly as they did before this rebuild.
 */
async function fillAndSubmitSignup(page, email, password) {
  await advanceToPasswordStep(page, email);
  await page.fill('#fn-password', password);
  await page.click('#fn-s13-continue');
}

/**
 * Reaches screen 13 (the email step) starting from a fresh ?resume=1 load.
 * As of 2026-07-31 (tracker item
 * for-product-urgent-founder-screenshots-i-g64gjp), the funnel's former
 * characters screen and "preparing" transition screen (renderScreen11)
 * were both removed outright, so a fresh ?resume=1 load now lands directly
 * on screen 13 — there is no intermediate screen left to click through.
 * `gotoFn` is the caller's own safeGoto-style wrapper (each file already
 * has one, with its own tolerance for this sandbox's transient
 * outbound-network quirk — see CLAUDE.md).
 */
async function reachScreen13(page, gotoFn, resumeUrl, caption) {
  await gotoFn(page, resumeUrl(caption));
  await page.waitForSelector('#fn-email', { timeout: 5000 });
}

module.exports = { advanceToPasswordStep: advanceToPasswordStep, fillAndSubmitSignup: fillAndSubmitSignup, reachScreen13: reachScreen13 };
