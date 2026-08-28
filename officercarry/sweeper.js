// ---------------------------------------------------------------------------
// Weekly roll — Monday 00:00 GMT+7.
//
// Spec: docs/OFFICER_CARRY_SCHEDULER_SPEC.md §4.
//
// WHY A SWEEPER RATHER THAN A setTimeout AIMED AT NEXT MONDAY: the timer dies
// with the process, and this bot redeploys on every push to Railway. A week
// boundary missed because someone shipped on Sunday evening would leave last
// week's slots on the board indefinitely, which is exactly the failure that
// makes a scheduler untrustworthy.
//
// The boundary lives in Mongo as `weekEndAt` and is re-read every tick, so a
// bot that was down across the boundary simply catches up on its first tick
// after boot rather than losing the roll.
//
// IDEMPOTENT BY CONSTRUCTION. The roll is driven by archiveWeek()'s conditional
// update, which flips status only if it is still 'active'. Two overlapping
// ticks, or two Railway instances, cannot both roll the same week: the loser's
// modifiedCount is 0 and it stops. And because the query is "active weeks whose
// end has passed", a bot down for three weeks rolls each stale week exactly
// once rather than three times over.
// ---------------------------------------------------------------------------

const db = require('./db');
const render = require('./render');
const { SWEEP_INTERVAL_MS } = require('./constants');

let timer = null;

/**
 * Roll every week whose window has ended. Returns the number rolled.
 * Never throws — a failure here must not take the bot down.
 */
async function sweepOnce(client) {
  if (!db.isReady()) return 0;

  let expired;
  try {
    expired = await db.listExpiredActiveWeeks(new Date());
  } catch (err) {
    console.warn('[officercarry/sweeper] Could not query expired weeks:', err?.message || err);
    return 0;
  }

  let rolled = 0;

  for (const old of expired) {
    try {
      // Conditional: only the caller that actually flips 'active' proceeds.
      const won = await db.archiveWeek(old._id);
      if (!won) continue;

      // Fresh week for the same guild. getOrCreateActiveWeek keys off the
      // CURRENT clock, so a bot that was down for three weeks lands on the
      // right week rather than the one immediately after the archived one.
      const fresh = await db.getOrCreateActiveWeek(old.guildId, new Date());
      if (!fresh) continue;

      // Carry the board's location across so it keeps its permalink and is
      // edited into the new week rather than reposted (spec §4.2).
      if (old.panelMessageId) {
        await db.adoptPanelFrom(old, fresh._id);
        await repaint(client, old.panelChannelId, old.panelMessageId, fresh._id);
      }

      rolled += 1;
      console.log(`[officercarry/sweeper] Rolled ${old.weekKey} -> ${fresh.weekKey} for guild ${old.guildId}.`);
    } catch (err) {
      console.warn(`[officercarry/sweeper] Roll failed for ${old._id}:`, err?.message || err);
    }
  }

  return rolled;
}

async function repaint(client, channelId, messageId, weekId) {
  try {
    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (!channel) return;
    const message = await channel.messages.fetch(messageId).catch(() => null);
    if (!message) return;
    const doc = await db.getWeekById(weekId);
    if (!doc) return;
    await message.edit(render.panelPayload(doc));
  } catch (err) {
    console.warn('[officercarry/sweeper] Board repaint failed:', err?.message || err);
  }
}

/**
 * Sweep once at boot (catching up anything missed while down), then every
 * SWEEP_INTERVAL_MS. Never throws to the boot path.
 */
function start(client) {
  if (timer) return;

  sweepOnce(client).catch(err =>
    console.warn('[officercarry/sweeper] Initial sweep failed:', err?.message || err));

  timer = setInterval(() => {
    sweepOnce(client).catch(err =>
      console.warn('[officercarry/sweeper] Sweep failed:', err?.message || err));
  }, SWEEP_INTERVAL_MS);

  if (typeof timer.unref === 'function') timer.unref();

  console.log(`[officercarry/sweeper] Started — checking the week boundary every ${Math.round(SWEEP_INTERVAL_MS / 60000)} min.`);
}

function stop() {
  if (timer) { clearInterval(timer); timer = null; }
}

module.exports = { sweepOnce, start, stop };
