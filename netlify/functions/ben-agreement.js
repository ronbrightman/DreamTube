// netlify/functions/ben-agreement.js
//
// Read + write endpoint behind ben-x7q4.html, the founder's family
// agreement tracker (see lib/ben-agreement-store.js's own header comment
// for the agreement, the record shape, and why writes go through a
// compare-and-verify loop).
//
//   GET  -> { ok:true, days, updatedAt }
//   POST { date, field:'s'|'r', value:boolean } -> { ok:true, days, updatedAt }
//
// The POST body names ONE flag on ONE day rather than handing back a whole
// days map. That is deliberate: the two people using this page are a
// parent and a child on separate phones, both with the page open, and a
// whole-map write would let whichever of them tapped last silently erase
// the other's ticks. One flag per request means the store merges instead
// of overwriting.
//
// NOT AUTHENTICATED, on purpose and with a known cost. The whole point of
// this page is that the child has no account anywhere — no claude.ai
// login, no DreamTube account, nothing to sign into — so there is no
// identity to check. The only thing standing between a stranger and this
// record is not knowing the page exists, exactly like every other
// -x7q4 page in this repo. Two things bound what a stranger who DID find
// it could do: writes are limited to real calendar days inside the
// agreement's own window (MIN_DATE..tomorrow — see validateDate below, so
// nobody can tick a thousand future days and zero out the countdown), and
// the whole record holds nothing but two booleans per day. Nothing here
// is a credential, a payment detail, or anyone's personal data, so the
// same "public read, nothing secret" reasoning get-tracker-items.js/
// get-smoke-status.js document for themselves applies to the write side
// too — the damage ceiling is "someone messes with a family calendar",
// recoverable by re-ticking the affected days.
//
// MIN_DATE is the agreement's own start (2026-08-17) — the page greys out
// everything earlier, and this endpoint enforces the same bound rather
// than trusting that. The upper bound is UTC-tomorrow, not UTC-today,
// because both phones are in Israel (UTC+3): their local calendar day is
// ahead of UTC's for three hours every evening, and a child ticking
// "today" at 01:00 local must not be told his own date is in the future.
//
// Rate-limited per IP via lib/rate-limit.js's checkAndIncrement — the
// per-day-bucket mechanism report-dream.js established for its own
// anonymous-friendly endpoint, and the right scope here for the same
// reason: there is no account to key on. The limit is set far above any
// real use (two people ticking a handful of boxes a day) purely as a
// backstop against a script filling the store.
//
// Error codes (local to this function, same small-number scheme as
// get-smoke-status.js/report-smoke-status.js):
//   E1 method_not_allowed
//   E2 invalid_json
//   E3 invalid_date        — not YYYY-MM-DD, or outside MIN_DATE..tomorrow
//   E4 invalid_field       — `field` is not 's' or 'r'
//   E5 invalid_value       — `value` is not a boolean
//   E6 write_failed        — every retryingWrite attempt's verify failed
//   E7 rate_limited        — MAX_WRITES_PER_IP_PER_DAY exceeded (429)

var benAgreementStore = require('./lib/ben-agreement-store');
var rateLimit = require('./lib/rate-limit');

var MIN_DATE = '2026-08-17';
var MAX_WRITES_PER_IP_PER_DAY = 400;

function json(statusCode, payload) {
  return { statusCode: statusCode, headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) };
}

/** True only for a real YYYY-MM-DD inside MIN_DATE..UTC-tomorrow (see the header comment on why tomorrow, not today). */
function validateDate(date) {
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  // Rejects a well-formed-but-impossible date like 2026-02-31, which the
  // regex alone accepts: Date's own normalization rolls it into March, so
  // the round-trip back to a string no longer matches what came in.
  if (new Date(date + 'T00:00:00Z').toISOString().slice(0, 10) !== date) return false;
  var tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  return date >= MIN_DATE && date <= tomorrow;
}

exports.handler = async function (event) {
  if (event.httpMethod === 'GET') {
    var record = await benAgreementStore.readRecord(event);
    return json(200, { ok: true, days: record.days, updatedAt: record.updatedAt });
  }

  if (event.httpMethod !== 'POST') {
    return json(405, { ok: false, error: 'E1: method_not_allowed' });
  }

  var body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch (err) {
    return json(400, { ok: false, error: 'E2: invalid_json' });
  }

  if (!validateDate(body.date)) {
    return json(400, { ok: false, error: 'E3: invalid_date' });
  }
  if (body.field !== 's' && body.field !== 'r') {
    return json(400, { ok: false, error: 'E4: invalid_field' });
  }
  if (typeof body.value !== 'boolean') {
    return json(400, { ok: false, error: 'E5: invalid_value' });
  }

  var limit = await rateLimit.checkAndIncrement(event, 'ben-agreement-write', rateLimit.clientIp(event), MAX_WRITES_PER_IP_PER_DAY);
  if (!limit.allowed) {
    return json(429, { ok: false, error: 'E7: rate_limited' });
  }

  var written = await benAgreementStore.setDayFlag(event, body.date, body.field, body.value);
  if (!written) {
    return json(503, { ok: false, error: 'E6: write_failed' });
  }

  return json(200, { ok: true, days: written.days, updatedAt: written.updatedAt });
};
