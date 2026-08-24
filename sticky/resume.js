// ---------------------------------------------------------------------------
// Sticky message boot-time resume — called from events/ready.js after a
// successful sticky/db.initSchema().
//
// The engine's watch Map is a CACHE (sticky/engine.js). Mongo is the source of
// truth, and this is the ONLY thing standing between a Railway restart and a
// set of stickies that silently stop following their channels. Everything a
// sticky is — content, title, colour, the live message id — comes back from the
// sticky_messages document.
//
// RE-ATTACH, DO NOT REPOST (spec §7/§9). The persisted `messageId` is adopted
// as-is and nothing is sent. Two reasons:
//
//   1. Railway redeploys on every push, so a repost-on-boot would republish
//      every sticky in the server on every deploy — visible noise for no gain.
//   2. A sticky's job is to follow conversation. If the channel has been quiet
//      through the downtime the sticky is still at the bottom and reposting it
//      would achieve nothing; if it has NOT been quiet, `lastRepostAt` starts at
//      0 so the very next human message reposts immediately, with no debounce
//      wait. Either way the correct thing happens on its own.
//
// Self-healing: if the sticky was deleted by hand while the bot was down, the
// adopted id simply won't match `channel.lastMessageId`, so the next message
// triggers a repost and the stale id is deleted best-effort. No fetch needed.
//
// The one thing this DOES reconcile is channels that vanished during downtime:
// their record is removed rather than retried forever (spec §6).
//
// FAILURE POSTURE: never throws to the boot path. A resume failure leaves the
// bot fully online with stickies parked where they are.
// ---------------------------------------------------------------------------

const db = require('./db');
const engine = require('./engine');

async function resume(client) {
  if (!db.isReady()) return 0;

  try {
    const docs = await db.listAll();
    let restored = 0;
    let dropped = 0;

    for (const doc of docs) {
      const channelId = doc._id;

      let channel = null;
      try {
        channel = await client.channels.fetch(channelId);
      } catch { /* fetch failed — treated as gone below */ }

      if (!channel?.isTextBased?.()) {
        // The channel is gone (or is no longer something we can post in).
        // Clean the record up instead of watching a hole forever.
        engine.forget(channelId);
        try { await db.remove(channelId); } catch { /* retried next boot */ }
        dropped += 1;
        console.warn(`[sticky/resume] Channel ${channelId} is gone — sticky record removed.`);
        continue;
      }

      engine.attach(doc);
      restored += 1;
    }

    if (restored || dropped) {
      console.log(`[sticky/resume] Re-attached ${restored} sticky message(s); ${dropped} dropped (channel gone).`);
    }
    return restored;
  } catch (err) {
    console.warn('[sticky/resume] Resume failed (stickies parked; nothing lost):', err?.message || err);
    return 0;
  }
}

module.exports = { resume };
