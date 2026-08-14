// ---------------------------------------------------------------------------
// Deferred deletion of resolved ticket channels.
//
// WHY A SWEEPER RATHER THAN A setTimeout AT RESOLVE TIME: a 24h timer dies with
// the process, so any redeploy inside the grace window would strand the channel
// forever. The deletion deadline lives in Mongo (`deleteAfter`), and this sweep
// reads it fresh every tick — a bot that was down simply catches up on its next
// tick instead of losing the deletion.
//
// This is also what keeps the category under Discord's 50-child cap, which is
// the constraint that would otherwise wedge the whole feature.
// ---------------------------------------------------------------------------

const db = require('./db');
const sticky = require('./sticky');
const { deleteTicketChannel } = require('./channel');
const { SWEEP_INTERVAL_MS } = require('./constants');

let timer = null;

async function sweepOnce(client) {
  if (!db.isReady()) return 0;

  let due;
  try {
    due = await db.listChannelsDueForDeletion();
  } catch (err) {
    console.warn('[ticket/sweeper] Could not query due channels:', err?.message || err);
    return 0;
  }

  let deleted = 0;
  for (const ticket of due) {
    const gone = await deleteTicketChannel(
      client,
      ticket.channelId,
      `Ticket ${ticket._id} resolved — grace period elapsed`,
    );
    if (gone) {
      sticky.forget(ticket.channelId);
      await db.clearChannel(ticket._id);
      deleted++;
    }
    // If it did not go, leave deleteAfter in place — the next tick retries.
  }

  if (deleted) {
    console.log(`[ticket/sweeper] Deleted ${deleted} resolved ticket channel(s) past their grace period.`);
  }
  return deleted;
}

// Run one sweep immediately (catching up on anything missed during downtime),
// then every SWEEP_INTERVAL_MS. Never throws to the boot path.
function start(client) {
  stop();

  sweepOnce(client).catch(err =>
    console.warn('[ticket/sweeper] Initial sweep failed:', err?.message || err));

  timer = setInterval(() => {
    sweepOnce(client).catch(err =>
      console.warn('[ticket/sweeper] Sweep failed:', err?.message || err));
  }, SWEEP_INTERVAL_MS);

  // Never keep the process alive just for the sweeper.
  if (typeof timer.unref === 'function') timer.unref();

  console.log(`[ticket/sweeper] Started — sweeping every ${Math.round(SWEEP_INTERVAL_MS / 60000)} min.`);
}

function stop() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

module.exports = { start, stop, sweepOnce };
