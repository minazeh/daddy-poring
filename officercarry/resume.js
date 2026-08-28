// ---------------------------------------------------------------------------
// Boot-time board adoption — called from events/ready.js after a successful
// officercarry/db.initSchema().
//
// Spec: docs/OFFICER_CARRY_SCHEDULER_SPEC.md §6.
//
// RE-ATTACH AND REPAINT, DO NOT REPOST. The persisted `panelMessageId` is
// adopted and edited; nothing is sent. Two reasons, the same ones behind
// sticky/resume.js:
//
//   1. Railway redeploys on every push, so posting on boot would republish the
//      board on every deploy — a wall of duplicates in the channel for no gain.
//   2. The board is meant to be a permanent, linkable fixture. A permalink that
//      changes whenever someone ships is not a fixture.
//
// The repaint matters as much as the adoption: while the bot was down the
// sweeper could not roll the week, so the message on screen may be showing a
// week that has already ended. sweeper.start() runs an immediate sweep right
// after this, and the two together mean a restart always lands on a correct,
// current board.
//
// Self-healing: if the board was deleted by hand during downtime the fetch
// fails, the stored id is cleared, and /officercarry panel posts a fresh one.
// Nothing retries forever.
//
// FAILURE POSTURE: never throws to the boot path. A resume failure leaves the
// bot fully online with the board simply unrefreshed until the next change.
// ---------------------------------------------------------------------------

const db = require('./db');
const render = require('./render');

async function adoptPanels(client) {
  if (!db.isReady()) return 0;

  let weeks;
  try {
    weeks = await db.listActiveWeeks();
  } catch (err) {
    console.warn('[officercarry/resume] Could not list active weeks:', err?.message || err);
    return 0;
  }

  let adopted = 0;

  for (const doc of weeks) {
    if (!doc.panelChannelId || !doc.panelMessageId) continue;

    try {
      const channel = await client.channels.fetch(doc.panelChannelId).catch(() => null);
      if (!channel) {
        // Channel vanished during downtime — clear rather than retry forever.
        await db.setPanel(doc._id, null, null);
        console.warn(`[officercarry/resume] Panel channel ${doc.panelChannelId} is gone — cleared.`);
        continue;
      }

      const message = await channel.messages.fetch(doc.panelMessageId).catch(() => null);
      if (!message) {
        await db.setPanel(doc._id, null, null);
        console.warn('[officercarry/resume] Board message was deleted — cleared; repost with /officercarry panel.');
        continue;
      }

      await message.edit(render.panelPayload(doc));
      adopted += 1;
    } catch (err) {
      console.warn(`[officercarry/resume] Could not adopt board for ${doc._id}:`, err?.message || err);
    }
  }

  if (adopted) console.log(`[officercarry/resume] Adopted and repainted ${adopted} board(s).`);
  return adopted;
}

module.exports = { adoptPanels };
