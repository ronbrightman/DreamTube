// test/helpers/fetch-double.js
//
// One line of plumbing for tests that install their own global.fetch double
// AND assert on server-side analytics fires (tracker.html's
// for-product-bug-founder-affects-all-funn-0efe7t item, round 4).
//
// netlify/functions/lib/posthog-capture.js reads POSTHOG_KEY out of a
// checked-in file rather than an env var, so it will happily POST real events
// into the founder's REAL production PostHog project from any process that
// require()s it — including `npm test`. That measurably happened: 10 real
// events per suite run, which then got read back as production anomalies and
// cost multiple rounds of misdiagnosis on that tracker item.
//
// That helper now refuses to fire from a test process UNLESS the currently
// installed global.fetch identifies itself as a recording double, which is
// what this marks. Tests that install a double and then assert "the event
// fired" call this right after installing it; everything else stays
// suppressed by default. Forgetting the call can only ever cause a local
// assertion failure, never a silent leak of production analytics — see that
// helper's own comment for why the marker is on the double rather than
// inferred from load order.
function markInstalledFetchAsTestDouble() {
  if (typeof global.fetch === 'function') {
    global.fetch.__dreamtubeTestDouble = true;
  }
  return global.fetch;
}

module.exports = { markInstalledFetchAsTestDouble };
