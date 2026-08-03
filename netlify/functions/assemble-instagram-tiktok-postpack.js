// netlify/functions/assemble-instagram-tiktok-postpack.js
//
// Nightly scheduled Netlify Function — tracker item
// for-product-instagram-tiktok-auto-postin-cahr76, Manager's SPEC v1
// ("build the manual-export MVP now, APIs later"). Assembles a "post
// pack" of ready-to-post items from recently-published dreams that carry
// real channel-license consent (see lib/postpack-selector.js's own header
// comment for the exact eligibility rules), so the founder can browse,
// download, and manually post them to Instagram/TikTok in under a minute
// per item via the owner-only postpack-h4mv.html page. NOTHING in this
// file ever calls a real social-platform API — see this tracker item's
// own explicit Phase-1-only scope; that's Phase 2, deliberately not built
// here.
//
// Same `schedule()`-wrapper + inline export convention as
// send-daily-claim-pushes.js/send-whatsapp-morning-capture.js (this repo's
// two existing scheduled functions) — the ACTUAL cron declaration lives in
// netlify.toml (belt-and-suspenders, per those files' own header comments:
// no way to invoke Netlify's real scheduler from this sandbox to confirm
// which mechanism a given deploy honors first).
//
// MECHANISM:
//   1. Read the whole shared feed (get-feed.js's own "dreamtube-feed"/
//      "feed-index" blob) and the whole moderation-reports list
//      (lib/moderation-store.js) — both small, single-blob, full-scan
//      reads, same "fine at this app's current real scale" tradeoff
//      send-daily-claim-pushes.js/admin-media-library-data.js already
//      accept for an identical shape.
//   2. lib/postpack-selector.js's getEligibleCandidatesNewestFirst turns
//      that into an ordered, filtered candidate list — a pure function,
//      see that module's own header comment for the exact eligibility
//      rules (real channel-license consent, not revoked, not opted out,
//      not reported, has real media).
//   3. For each channel (Instagram, TikTok — two independent lanes per
//      this feature's own spec: "the pack should be built per-channel...
//      so max-1/day/channel is enforceable"):
//      a. MAX-1-PER-DAY-PER-CHANNEL: claim a per-channel-per-UTC-day dedup
//         key via lib/push-dedup-store.js's existing markSentOnce (REUSED,
//         not reinvented — this feature's own spec explicitly calls that
//         out: "similar to this codebase's existing markSentOnce-style
//         dedup patterns ... reuse it, don't invent a new one"). If a pack
//         was already built for this channel today (this job re-firing the
//         same day, or having already run once today), this channel is
//         skipped for the rest of today — the SAME markSentOnce shape
//         send-daily-claim-pushes.js's own 'daily-claim-available:'+...
//         key already uses for its own "once per real-world window"
//         guarantee.
//      b. NEVER-REPEAT-ACROSS-ALL-HISTORY: walk the candidate list newest-
//         first, skipping any dream whose GLOBAL 'postpack-dream:'+id
//         marker is already set (checked via the same store's hasSent) —
//         once a dream has been included in ANY pack, for ANY channel,
//         ever, it is permanently excluded from every future pack. This is
//         deliberately a single global marker, not a per-channel one: the
//         spec's own wording ("needs a durable already-included-in-a-pack
//         marker") describes one mark per dream, not "used for Instagram"
//         and "used for TikTok" as separate facts — a dream that already
//         went out on Instagram gets no second life as fresh TikTok
//         content either.
//      c. The first still-unused eligible candidate is claimed (its own
//         global marker set) and turned into a pack item (caption/
//         hashtags via lib/postpack-caption.js, media reference passed
//         through as-is — see this function's own comment above the item
//         object), then durably appended via lib/postpack-store.js.
//   4. Returns { scanned, built: [...] } — `built` is exposed for direct
//      testing (see test/assemble-instagram-tiktok-postpack.test.js) and
//      logged (count only, no dream content) on the real scheduled path.
//
// media reference: passed straight through from the feed record's own
// videoUrl/imageUrl — this codebase already has exactly one way media is
// served/downloaded (a durable /.netlify/functions/video-file.mjs or
// image-file.mjs URL once re-hosted, or the original fal url otherwise —
// see that file's own header comment), and media-library-x7q4.html already
// treats a feed record's videoUrl/imageUrl as a directly usable, open-able
// URL with no extra indirection. Building a second "resolve this into a
// downloadable thing" layer here would just be duplicating that existing
// serving path for no benefit.

var { schedule } = require('@netlify/functions');
var { connectLambda, getStore } = require('@netlify/blobs');
var postpackSelector = require('./lib/postpack-selector');
var postpackCaption = require('./lib/postpack-caption');
var postpackStore = require('./lib/postpack-store');
var moderationStore = require('./lib/moderation-store');
var pushDedupStore = require('./lib/push-dedup-store');

var CHANNELS = ['instagram', 'tiktok'];

// Today's date as a plain "YYYY-MM-DD" string, UTC — same rollover
// convention as get-feed.js's own todayUTC (this app has no per-user
// timezone anywhere else either; a deliberate simplification, not a
// correctness requirement worth a timezone library for).
function todayUTC() {
  return new Date().toISOString().slice(0, 10);
}

function dailyChannelDedupKey(channel, day) {
  return 'postpack-daily:' + channel + ':' + day;
}

function everUsedDedupKey(dreamId) {
  return 'postpack-dream:' + dreamId;
}

/**
 * Does the actual scan + build. Exposed separately from the scheduled
 * `exports.handler` below so test/assemble-instagram-tiktok-postpack.test.js
 * can call it directly with a fake event/mocked stores, same pattern
 * send-daily-claim-pushes.js's own scanAndSend uses.
 */
async function scanAndBuild(event) {
  connectLambda(event);
  var feedStore = getStore('dreamtube-feed');
  var feed = (await feedStore.get('feed-index', { type: 'json' })) || [];

  var reports = await moderationStore.getReports(event);
  var reportedDreamIds = new Set(reports.map(function (r) { return r.dreamId; }));

  var candidates = postpackSelector.getEligibleCandidatesNewestFirst(feed, reportedDreamIds);

  var today = todayUTC();
  var built = [];

  for (var i = 0; i < CHANNELS.length; i++) {
    var channel = CHANNELS[i];

    var dailyClaim = await pushDedupStore.markSentOnce(event, dailyChannelDedupKey(channel, today));
    if (!dailyClaim.ok) continue; // already built a pack for this channel today

    var picked = null;
    for (var c = 0; c < candidates.length; c++) {
      var candidate = candidates[c];
      var alreadyUsed = await pushDedupStore.hasSent(event, everUsedDedupKey(candidate.id));
      if (alreadyUsed) continue;
      picked = candidate;
      break;
    }
    if (!picked) continue; // nothing eligible and not-yet-used left for this channel today

    // Claim the GLOBAL never-repeat marker for this dream before building/
    // persisting the item -- fail closed (skip this channel this run rather
    // than double-include) if the CAS claim itself doesn't win, same
    // "refuse to guess" posture push-dedup-store.js's own markSentOnce
    // documents for every other caller.
    var everUsedClaim = await pushDedupStore.markSentOnce(event, everUsedDedupKey(picked.id));
    if (!everUsedClaim.ok) continue;

    var item = {
      id: picked.id + ':' + channel,
      dreamId: picked.id,
      channel: channel,
      ownerHandle: picked.ownerHandle || null,
      style: picked.style || null,
      mediaType: picked.mediaType === 'image' ? 'image' : (picked.videoUrl ? 'video' : 'image'),
      mediaUrl: picked.videoUrl || picked.imageUrl || null,
      caption: postpackCaption.buildCaption(picked),
      hashtags: postpackCaption.buildHashtags(picked.style),
      builtAt: Date.now()
    };

    await postpackStore.appendItem(event, item);
    built.push(item);
  }

  return { scanned: feed.length, built: built };
}

exports.handler = schedule('0 7 * * *', async function (event) {
  try {
    var result = await scanAndBuild(event);
    console.log('assemble-instagram-tiktok-postpack: scanned ' + result.scanned + ' feed record(s), built ' + result.built.length + ' pack item(s)');
  } catch (e) {
    // Best-effort, same "never let this surface as a hard failure"
    // discipline as every other background job in this codebase -- a
    // failed run just means today's pack (for whichever channel(s) didn't
    // get claimed) doesn't get built; tomorrow's scheduled run tries again
    // (and the per-channel-per-day dedup key naturally rolls over to a
    // fresh day, so nothing is permanently lost by a single failed night).
    console.error('assemble-instagram-tiktok-postpack: unexpected error', e);
  }
  return { statusCode: 200 };
});

// Exposed for direct unit testing (test/assemble-instagram-tiktok-postpack.test.js).
exports.scanAndBuild = scanAndBuild;
exports.CHANNELS = CHANNELS;
