// netlify/functions/lib/effective-config.js
//
// Tracker item for-product-damage-assessment-env-var-ca-rmgaqh: a live
// Netlify env var (MAX_GENERATIONS_PER_IP_PER_DAY) sat at 2 -- silently
// overriding the checked-in code default of 40 -- with nothing in
// Netlify's function logs able to reveal that, since every existing
// console.log in these functions logged the DECISION (e.g. "rate
// limited") never the resolved CONFIG NUMBER that decision was made
// against. A code review alone can never see an env var override; only
// a live log line can.
//
// logEffectiveConfigOnce(functionName, entries) exists purely to make
// that resolved number observable going forward: it logs each entry's
// EFFECTIVE value (the actual number the code will use after defaulting,
// not the raw env var string) plus the raw env var and the code default,
// so a human scanning Netlify's function logs can directly read "this is
// the live config right now" for a given function.
//
// Callers (generate-video.js/generate-image.js/start-pending-
// generation.js) invoke this from their own MODULE-LEVEL code -- outside
// exports.handler -- which Node only ever executes once per cold Lambda
// instance start, before any request is handled. That single call site
// placement, not anything in this file, is what makes this "once per
// cold start, not once per request": this file has no request-count
// guard of its own because it doesn't need one -- see each caller's own
// comment at its call site for the reasoning.
//
// Deliberately read-only / logging-only: nothing here is imported by any
// request-handling code path for its resolved VALUE (each handler keeps
// its own identical, independent parse+default logic exactly as it was
// before this file existed -- see each handler's own maxPerDay/
// dailyCapUsd lines). That duplication is intentional, not an oversight:
// this task is scoped to purely additive observability, so the actual
// rate-limiting/cost-control code path is left completely untouched
// rather than refactored to share this resolver.

var PREFIX = 'effective_config:';

function resolveIntEnvWithDefault(envVarName, defaultValue) {
  var parsed = parseInt(process.env[envVarName], 10);
  if (!parsed || parsed <= 0) return defaultValue;
  return parsed;
}

function resolveFloatEnvWithDefault(envVarName, defaultValue) {
  var parsed = parseFloat(process.env[envVarName]);
  if (!parsed || parsed <= 0) return defaultValue;
  return parsed;
}

/**
 * Logs the resolved effective value of each entry in `entries` for
 * `functionName`. entries: [{ envVar, default, type: 'int'|'float' }, ...].
 * One console.log line per entry, each independently greppable via the
 * shared 'effective_config:' prefix and carrying `functionName` so a scan
 * across multiple functions' logs can tell which one logged what.
 */
function logEffectiveConfigOnce(functionName, entries) {
  entries.forEach(function (entry) {
    var resolve = entry.type === 'float' ? resolveFloatEnvWithDefault : resolveIntEnvWithDefault;
    var effective = resolve(entry.envVar, entry.default);
    var rawEnvValue = process.env[entry.envVar];
    var rawDisplay = rawEnvValue === undefined ? 'unset' : JSON.stringify(rawEnvValue);
    console.log(
      PREFIX + ' fn=' + functionName + ' ' + entry.envVar + '=' + effective +
      ' (raw_env=' + rawDisplay + ', code_default=' + entry.default + ')'
    );
  });
}

module.exports = {
  logEffectiveConfigOnce: logEffectiveConfigOnce,
  resolveIntEnvWithDefault: resolveIntEnvWithDefault,
  resolveFloatEnvWithDefault: resolveFloatEnvWithDefault
};
