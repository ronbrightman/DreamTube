// netlify/functions/lib/ben-agreement-store.js
//
// Backing store for ben/index.html — the founder's family agreement with
// his son over when Instagram may be installed. ONE shared record, read
// and written by exactly two people (the son on his own phone, the
// founder on his), so the page shows both of them the same numbers
// without either needing an account anywhere.
//
// The agreement itself: the son's 13th birthday (2027-03-24) is the base
// date; each day he keeps to his screen-time limit brings it one day
// closer, each day he reads brings it one more. The page owns all of that
// arithmetic — this store only records which of the two boxes are ticked
// on which calendar day, because that is the only thing that cannot be
// recomputed from scratch.
//
// STORE NAME: 'dreamtube-ben-agreement'. KEY: 'agreement' — a single
// record, not one blob per day. Two people ticking at most four boxes a
// day will not grow this past a few KB even by the 2027 target date, and
// a single record is what lets the page render the whole calendar from
// one GET rather than a list() plus a read per day (the shape
// smoke-status-store.js's getAllResults pays for, and does not need here).
//
// RECORD SHAPE:
//   { days: { 'YYYY-MM-DD': { s: boolean, r: boolean } }, updatedAt: ISO }
// `s` = kept to the screen-time limit, `r` = read that day. A day with
// neither is DELETED rather than stored as { s:false, r:false }, so the
// record stays a list of days that earned something instead of one entry
// per elapsed day.
//
// WHY CAS/RETRY HERE (unlike smoke-status-store.js's plain upsert): both
// writers touch the SAME key, and a lost write is directly visible to a
// child as a tick that silently un-ticked itself — the exact class of
// "shared array, a lost concurrent write silently drops something real"
// that lib/blobs-retry.js's own header comment cites tracker-store.js
// for. setDayFlag therefore goes through retryingWrite's bounded
// read -> mutate -> write -> verify loop, mutating ONE flag on ONE day
// rather than writing back a whole client-supplied map, so two
// simultaneous ticks on different days (or different boxes of the same
// day) both survive instead of one clobbering the other.

var { getStore, connectLambda } = require('@netlify/blobs');
var blobsRetry = require('./blobs-retry');

var STORE_NAME = 'dreamtube-ben-agreement';
var KEY = 'agreement';

/** The empty record a never-written store reads back as — same "default rather than null" shape support-store.js's getMessages uses. */
function emptyRecord() {
  return { days: {}, updatedAt: null };
}

async function readRecord(event) {
  connectLambda(event);
  var record = await getStore({ name: STORE_NAME }).get(KEY, { type: 'json' });
  if (!record || typeof record !== 'object' || typeof record.days !== 'object' || record.days === null) {
    return emptyRecord();
  }
  return { days: record.days, updatedAt: record.updatedAt || null };
}

/**
 * Sets ONE flag (`field` is 's' or 'r') on ONE day to `value`, merging
 * into whatever the other writer has already recorded.
 *
 * Idempotent against its own end state, as retryingWrite's contract
 * requires: it assigns the requested boolean rather than toggling, so a
 * retry triggered by a false-negative verify (our own write not yet
 * visible to an eventually consistent read) re-applies the same result
 * instead of flipping the flag back.
 *
 * Returns the record as stored, or null if every attempt's verify failed
 * — the caller surfaces that as a real failure rather than reporting a
 * tick that may not have landed.
 */
async function setDayFlag(event, date, field, value) {
  var result = await blobsRetry.retryingWrite(event, STORE_NAME, KEY, {
    read: readRecord,
    mutate: function (current) {
      var days = Object.assign({}, current.days);
      var day = Object.assign({ s: false, r: false }, days[date]);
      day[field] = value;
      if (!day.s && !day.r) delete days[date];
      else days[date] = day;
      return { days: days, updatedAt: new Date().toISOString() };
    },
    verify: function (verifyRead) {
      if (!verifyRead || typeof verifyRead.days !== 'object' || verifyRead.days === null) return false;
      var stored = verifyRead.days[date];
      var storedValue = !!(stored && stored[field]);
      return storedValue === value;
    }
  });
  return result.ok ? result.value : null;
}

module.exports = { STORE_NAME, KEY, readRecord, setDayFlag, emptyRecord };
