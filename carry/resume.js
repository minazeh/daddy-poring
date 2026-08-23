// ---------------------------------------------------------------------------
// Carry sales boot-time resume — called from events/ready.js after a successful
// carry/db.initSchema().
//
// This module is SHORT, and that is the point of spec §4.1. partyfinder/resume.js
// has to rehydrate in-memory Maps and restore an id high-water mark, because the
// process is the source of truth there and a restart wipes it. Here Mongo is the
// source of truth and nothing about a run or a booking is held in memory, so
// there is no state to rebuild — only two side effects to re-establish:
//
//   1. TIMERS. setTimeout does not survive a restart. Every still-pending hold
//      gets its 30-minute release re-armed from `pendingUntil`. A hold that
//      EXPIRED WHILE THE BOT WAS DOWN is released immediately (delay clamps to
//      0) rather than hanging forever — spec §10.
//
//   2. BOARD MESSAGES. Each live run's board is re-rendered from its persisted
//      message id, which also re-posts and re-persists any board somebody
//      deleted by hand while the bot was offline (spec §11).
//
// Plus one sweep: runs whose start time passed during downtime are restyled as
// concluded. The board message is LEFT IN PLACE — no auto-archive (spec §6).
//
// FAILURE POSTURE: never throws to the boot path. A resume failure leaves the
// bot fully online; seats and bookings are still correct in Mongo, holds just
// release on the next interaction that reads them rather than on a timer.
// ---------------------------------------------------------------------------

const db = require('./db');
const cs = require('./state');
const handlers = require('./handlers');

async function resume(client) {
  if (!db.isReady()) return;
  try {
    // 1. Runs whose start time passed while we were down.
    let concluded = 0;
    try {
      concluded = await handlers.concludeDueRuns(client);
    } catch (err) {
      console.warn('[carry/resume] Conclude sweep failed (runs still correct in Mongo):', err?.message || err);
    }

    // 2. Pending holds — release what expired, re-arm the rest.
    const pending = await db.listPendingBookings();
    let releasedOnBoot = 0;
    let rearmed = 0;

    for (const booking of pending) {
      try {
        const expired = new Date(booking.pendingUntil).getTime() <= Date.now();
        if (expired) {
          // releaseHold is conditional end to end, so this is safe to run for
          // every expired hold with no extra guard.
          if (await handlers.releaseHold(client, booking._id)) releasedOnBoot += 1;
          continue;
        }
        cs.armRelease(booking._id, booking.pendingUntil, id => handlers.releaseHold(client, id));
        rearmed += 1;
        // Re-post the officer entry if it was deleted while we were offline.
        await handlers.renderBookingEntry(client, booking._id);
      } catch (err) {
        console.warn(`[carry/resume] Skipping unrecoverable booking ${booking._id}:`, err?.message || err);
      }
    }

    // 3. Re-attach every live run's board message.
    const runs = await db.listLiveRuns();
    let boards = 0;
    for (const run of runs) {
      try {
        if (await handlers.renderRunBoard(client, run)) boards += 1;
      } catch (err) {
        console.warn(`[carry/resume] Could not re-attach the board for ${run._id}:`, err?.message || err);
      }
    }

    console.log(
      `[carry/resume] ${runs.length} live run(s), ${boards} board(s) re-attached; ` +
      `${concluded} run(s) concluded on boot; ` +
      `${rearmed} hold(s) re-armed, ${releasedOnBoot} expired hold(s) released immediately.`,
    );
  } catch (err) {
    console.warn('[carry/resume] Resume failed (carry sales still online, Mongo state unaffected):', err?.message || err);
  }
}

module.exports = { resume };
