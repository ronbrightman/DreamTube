# Testing video generation without spending real money

`netlify/functions/generate-video.js` has no cheap path by default — every
call to it that reaches fal.ai is a real, full-price Veo 3.1 Fast generation
(~$0.10-0.20/sec, hardcoded 8-second duration => roughly $0.80-1.60/call).
Per `AGENT_POLICY.md`'s standing rule ("Never spend real generation cost on
testing"), no agent may trigger a real call for testing/verification without
explicit human confirmation first. This doc covers the two dev/test-only env
vars that make that rule actually achievable, and how to use each.

`netlify/functions/generate-avatar.js` (the "Me" character's Describe ->
real-avatar-image path, see that file's own header) shares `GENERATION_MOCK_MODE`
below with generate-video.js — same flag, same "true" (exact string) trigger,
same all-guardrails-still-run behavior — just returning a small placeholder
`photoDataUrl` instead of a fake video `operationName`. It has no equivalent
of `GENERATION_TEST_DURATION` (nothing to shorten — a single flux/schnell
image has no duration parameter); at ~$0.003/image its real cost is low
enough that a real (non-mocked) test call is a non-issue either way, but
mock mode is still the default per the same "cheapest option that verifies
what's being tested" preference above. See test/generate-avatar*.test.js
for its own coverage.

## The two flags, and how they differ

| | `GENERATION_MOCK_MODE` | `GENERATION_TEST_DURATION` |
|---|---|---|
| Real fal.ai call? | Never | Yes — a genuinely real, billed generation |
| Cost | **$0** | Real money, just less of it (shorter duration) |
| Needs human approval to use? | No — this is exactly the safe default this doc exists to provide | **Yes** — per `AGENT_POLICY.md`, still requires explicit human confirmation before an agent uses it |
| Use for | Routine flow/UI/integration testing — this should be the default for basically everything | The rare case a genuinely real generation must be verified (e.g. confirming fal's actual API contract hasn't changed) |
| Safe in production? | **No — dev/test only, must never be `true` in the real production environment** (see below) | Also dev/test only, but by nature (it still spends real money) rather than by risk of breaking generation for real users |

**If both are set at once, `GENERATION_MOCK_MODE` always wins** — not by
extra precedence logic, but structurally: `generate-video.js`'s mock branch
returns before `GENERATION_TEST_DURATION` (or `FAL_KEY`, or any real fal
call) is ever read. Mock mode is the safer of the two, so it's the one that
takes priority.

## `GENERATION_MOCK_MODE`

Set to the exact string `"true"` to turn it on. Any other value, or leaving
it unset (the default in every environment today), leaves generation exactly
as it's always been — this is purely additive.

**What it does**, in `generate-video.js`:
- Skips every real fal.ai call entirely: no `FAL_KEY` is read, no network
  request to fal.ai is made at all.
- Still runs every guardrail exactly as it does on the real path — caption/
  style validation, the per-IP/per-email rate limit (`E109`), the
  unconditional token-balance gate (`E112`, see
  `netlify/functions/lib/entitlements.js`), and the daily spend-cap circuit
  breaker (`E110`). Mock mode is a stand-in for the model call
  itself, never a way to bypass the checks those guardrails exist to test —
  if you're testing the guardrails themselves, mock mode is exactly the
  right way to do it for free.
- Returns a fake `operationName` shaped `"mock:<startedAtMs>:<id>"` — an
  obviously-non-real prefix, in the same `{ operationName }` response shape
  the real path returns, so nothing on the client (`js/store.js`,
  `processing.html`) needs to know the difference.

**What `netlify/functions/video-status.js` does with it**: recognizes the
`"mock:"` prefix and, instead of polling fal's real status API, resolves to
`{ done: true, videoUrl }` after a short simulated delay (~20 seconds — a
couple of the client's own 10-second poll cycles, not instant) computed
purely from the timestamp embedded in the operation name itself. This means:
- The real "Generating…" polling/loading UI states in `processing.html`
  still get exercised, not skipped.
- No server-side memory or Blobs store is needed to track mock job state —
  Netlify Functions give no guarantee that repeated polls for the same job
  land on the same warm instance, so "is it done yet" has to be derivable
  from the operation name alone.
- The `videoUrl` returned points at a real, small (~770KB), stable,
  publicly-hosted sample MP4 (W3Schools' standard HTML5-video-tutorial clip,
  itself an excerpt of Blender Foundation's Big Buck Bunny, CC-BY 3.0) — not
  a broken link — so the rest of the flow downstream of a finished
  generation (`finalizeDream`, the client's real duration probe, Explore/
  Profile rendering) gets exercised against a real working video, at zero
  fal.ai cost. This is purely a test fixture, never shown to a real user.

**THIS MUST STAY DEFAULT-OFF/UNSET IN THE REAL PRODUCTION ENVIRONMENT.**
`GENERATION_MOCK_MODE=true` would silently stop every real user's generation
from ever producing a real video — same category of risk as
`PAYWALL_ENABLED` in `docs/PAYWALL_SETUP.md`, just in the opposite direction
(this one breaks generation for everyone if left on by mistake, rather than
gating it). Only set it in local dev / CI / an explicitly-scoped test/branch
deploy, never in the Netlify site's real production environment variables.

**How to use it locally or in CI:**
```
GENERATION_MOCK_MODE=true netlify dev
```
or, for `node --test` (see `test/generate-video-mock.test.js` and
`test/video-status-mock.test.js` for the existing coverage), just set
`process.env.GENERATION_MOCK_MODE = 'true'` before calling the handler —
no `FAL_KEY`, no Stripe setup, no real credentials of any kind needed.

## `GENERATION_TEST_DURATION`

Set to `"4s"`, `"6s"`, or `"8s"` (the only values fal's Veo 3.1 Fast — and
its reference-to-video variant, same underlying model — actually accept for
this parameter; confirmed against fal's current API docs, 2026-07) to make a
**real** fal.ai call at that duration instead of the hardcoded 8-second
default. Any unset or unsupported value (e.g. `"1s"`, which fal does not
support) silently falls back to the untouched default `"8s"` rather than
risk sending fal a value it would reject.

fal bills Veo 3.1 Fast per second, so this scales cost roughly linearly:
`"4s"` is about **half** the cost of the default 8-second generation
(~$0.40-0.80/call instead of ~$0.80-1.60/call).

**This still spends real money.** It exists only for the rare case a
genuinely real generation must be verified — e.g. confirming fal's actual
API contract hasn't changed — where `GENERATION_MOCK_MODE` can't stand in
because the whole point is exercising the real call. Per `AGENT_POLICY.md`'s
standing rule, **an agent must get explicit human confirmation before using
this**, exactly like triggering any other real generation — this flag only
reduces how much a confirmed real test costs, it does not make triggering
one an unsupervised decision.

## Running the tests

```
npm test
```

`test/generate-video-mock.test.js` and `test/video-status-mock.test.js`
cover both flags end-to-end at the function level (no real Stripe/fal
credentials needed for either): mock mode's response shape, that the real
fal.ai call functions are never invoked under mock mode (asserted via a
`global.fetch` spy expecting zero calls), that every existing guardrail
still runs under mock mode, that default (both flags unset) behavior is
completely unchanged, that `GENERATION_TEST_DURATION` correctly overrides
the real call's `duration` parameter, and that mock mode wins if both flags
are ever set at once.
