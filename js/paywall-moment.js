// js/paywall-moment.js
//
// PURE logic for the post-signup monetization moment (the one-screen offer
// shown to a freshly-signed-up user between the signup wall and home.html —
// see wizard.html's showMonetizationMoment for the DOM/checkout wiring that
// consumes this).
//
// Everything in here is deliberately DOM-free and side-effect-free (except
// via the caller-supplied `storage` shim) so it can be unit-tested directly
// without a browser — same dual-target require()/window pattern as
// js/wizard-chips.js and js/purchase-sheet.js. wizard.html attaches this on
// window.PaywallMoment; test/paywall-moment.test.js require()s it.
//
// ── The two A/B tests this owns ──
// TOP-LEVEL (paywall-arm, 50/50, assigned ONCE PER ACCOUNT, persisted keyed
// by a stable account hash):
//   'subscription' -> the Dreamer Pass paywall.
//   'tokens'       -> the 99¢/300-token starter pop-up.
// NESTED (paywall-trial-arm, 50/50, persisted) inside the subscription arm:
//   'free'  -> toggle-ON is a 3-day FREE trial.
//   'fifty' -> toggle-ON is a ONE-TIME $1 trial.
//
// passVariant mapping sent to create-checkout-session-dodo:
//   toggle OFF                    -> 'notrial'   ($7.99/mo, billed today)  [LIVE]
//   toggle ON + trial-arm 'free'  -> 'freetrial' ($9.99/mo, 3-day free)    [LIVE]
//   toggle ON + trial-arm 'fifty' -> 'trial50'   ($9.99/mo, one-time $1)  [GATED]
//
// >>> TRIAL50 GATE (money-critical) <<<
// trial50 must NOT reach real users until a real $1 purchase confirms Dodo
// reports the paid trial as `trialing` (so dodo-webhook.js's trial50 guard
// actually suppresses the 3,000-token grant at trial start). effectiveTrialArm
// hard-collapses a raw 'fifty' assignment to 'free' for real traffic while the
// gate is closed; only the founder's explicit `forced === 'fifty'` override
// (?trialarm=fifty) force-reveals trial50, for his own real-card test.
(function () {
  // 32-bit string hash — the SAME one wizard.html uses for its wall-subtext
  // A/B seed (wsHashStr), so account bucketing is consistent app-wide.
  function hashStr(s) {
    var h = 0;
    s = String(s || '');
    for (var i = 0; i < s.length; i++) { h = ((h << 5) - h + s.charCodeAt(i)) | 0; }
    return h;
  }

  /** Stable per-account hash string, seeded from the normalized (lowercased) email. */
  function hashAccount(email) { return String(Math.abs(hashStr(String(email || '').toLowerCase()))); }

  /** Deterministic 50/50 top-level arm from an account hash (no persistence). */
  function pickArm(hash) {
    return (Math.abs(hashStr(hash + ':paywall-arm')) % 2) === 0 ? 'subscription' : 'tokens';
  }

  /** Deterministic 50/50 RAW nested trial arm from an account hash (gate applied separately). */
  function pickTrialArm(hash) {
    return (Math.abs(hashStr(hash + ':paywall-trial-arm')) % 2) === 0 ? 'free' : 'fifty';
  }

  // Small localStorage-shim reader/writer: `storage` is any object exposing
  // getItem/setItem (real localStorage, or a fake in tests). Records are
  // {h: accountHash, arm} so an arm is only reused for the SAME account —
  // "assigned once per account". A read that throws, is absent, has bad JSON,
  // or belongs to a different account returns null (-> caller reassigns).
  function readPersistedArm(storage, key, hash) {
    if (!storage) return null;
    try {
      var raw = storage.getItem(key);
      if (!raw) return null;
      var obj = JSON.parse(raw);
      if (obj && obj.h === hash) return obj.arm;
    } catch (e) { /* reassign */ }
    return null;
  }
  function writePersistedArm(storage, key, hash, arm) {
    if (!storage) return;
    try { storage.setItem(key, JSON.stringify({ h: hash, arm: arm })); } catch (e) { /* private mode — still stable within this load */ }
  }

  var ARM_KEY = 'dt_paywall_arm';
  var TRIAL_ARM_KEY = 'dt_paywall_trial_arm';

  /**
   * Resolve + persist the top-level arm for this account.
   *   opts.forced  — a founder override ('subscription'|'tokens') or falsy.
   * A valid forced value wins and is persisted; else a persisted per-account
   * value is reused; else a fresh deterministic 50/50 is assigned and persisted.
   */
  function assignArm(hash, storage, opts) {
    opts = opts || {};
    if (opts.forced === 'subscription' || opts.forced === 'tokens') {
      writePersistedArm(storage, ARM_KEY, hash, opts.forced);
      return opts.forced;
    }
    var arm = readPersistedArm(storage, ARM_KEY, hash);
    if (arm !== 'subscription' && arm !== 'tokens') {
      arm = pickArm(hash);
      writePersistedArm(storage, ARM_KEY, hash, arm);
    }
    return arm;
  }

  /**
   * Resolve + persist the RAW nested trial arm ('free'|'fifty') for this
   * account. The GATE is NOT applied here (see effectiveTrialArm) so the raw
   * 50/50 stays persisted for when the flag flips.
   *   opts.forced — a founder override; only 'free'|'fifty' change the arm
   *                 ('notrial' is recognized but leaves the arm to normal
   *                 assignment, since toggle-OFF is notrial in either arm).
   */
  function assignTrialArm(hash, storage, opts) {
    opts = opts || {};
    if (opts.forced === 'free' || opts.forced === 'fifty') {
      writePersistedArm(storage, TRIAL_ARM_KEY, hash, opts.forced);
      return opts.forced;
    }
    var arm = readPersistedArm(storage, TRIAL_ARM_KEY, hash);
    if (arm !== 'free' && arm !== 'fifty') {
      arm = pickTrialArm(hash);
      writePersistedArm(storage, TRIAL_ARM_KEY, hash, arm);
    }
    return arm;
  }

  /**
   * The trial arm the user ACTUALLY sees (and checks out as). A raw 'fifty' is
   * collapsed to 'free' unless trial50 is enabled globally OR the founder
   * force-revealed it via forced === 'fifty'. This is the money-critical gate:
   * real users can never reach trial50 until `trial50Enabled` is flipped on.
   *   opts.trial50Enabled — the global gate flag (default false).
   *   opts.forced         — the ?trialarm override; 'fifty' force-reveals.
   */
  function effectiveTrialArm(rawArm, opts) {
    opts = opts || {};
    if (opts.forced === 'fifty') return 'fifty'; // founder override force-reveals trial50
    if (rawArm === 'fifty' && !opts.trial50Enabled) return 'free'; // GATE
    return rawArm;
  }

  /**
   * passVariant for create-checkout-session-dodo, from the toggle state and
   * the EFFECTIVE trial arm. $1 is always surfaced as "one-time" in copy; the
   * variant token itself is 'trial50'.
   */
  function passVariantFor(trialOn, trialArm) {
    if (!trialOn) return 'notrial';
    return trialArm === 'fifty' ? 'trial50' : 'freetrial';
  }

  var PaywallMoment = {
    ARM_KEY: ARM_KEY,
    TRIAL_ARM_KEY: TRIAL_ARM_KEY,
    hashStr: hashStr,
    hashAccount: hashAccount,
    pickArm: pickArm,
    pickTrialArm: pickTrialArm,
    assignArm: assignArm,
    assignTrialArm: assignTrialArm,
    effectiveTrialArm: effectiveTrialArm,
    passVariantFor: passVariantFor
  };

  if (typeof window !== 'undefined') window.PaywallMoment = PaywallMoment;
  if (typeof module !== 'undefined' && module.exports) module.exports = PaywallMoment;
})();
