// ---------------------------------------------------------------------------
// Party Finder boot-time resume (v2) — called from events/ready.js after a
// successful partyfinder/db.initSchema().
//
// Rehydrates every persisted party/carry doc back into the in-memory Maps
// (state.js), restores the id counter, and re-arms an expiry timer for each
// restored card so the existing pf:join/pf:leave/pf:cancel/pf:carry* buttons
// on already-posted Discord messages resolve again after a restart.
//
// ID-COLLISION SAFETY (option A — restore the high-water mark):
// partyId/requestId come from state.js's in-memory counter, which resets to 0
// on restart. The persisted docs are keyed by those ids AND the ids are baked
// into the customIds of already-posted buttons (pf:join:<cat>:<partyId>), so
// the ids themselves must be kept. If the counter restarted at 0, the first
// new card after a restart would mint id "1" and collide with a restored doc,
// corrupting both cards' state. Fix: scan the max numeric id across BOTH
// collections (including any closed/skipped docs) and raise the counter to it
// BEFORE any new card can be created — resume runs inside the ready handler,
// ahead of any user interaction being processed. Chosen over re-keying to
// messageId (option B) because it is a minimal, additive change that keeps
// the existing customId format on every already-posted card valid; option B
// would invalidate live buttons posted before the deploy and widen the diff
// across every handler for no behavioral gain.
//
// EXPIRY WHILE DOWN: scheduleExpiry clamps its delay to >= 0, so a card whose
// expiry passed while the bot was offline gets a timer that fires immediately
// after resume — which closes it out exactly like a normal expiry (grey embed,
// buttons removed, state + doc dropped). One code path for both cases.
//
// FAILURE POSTURE: never throws to the boot path. A resume failure (or a
// single corrupt doc) degrades to v1 behavior — empty/partial in-memory state,
// bot fully online.
// ---------------------------------------------------------------------------

const pfdb = require('./db');
const ps = require('./state');
const handlers = require('./handlers');

// Track the max numeric id seen (docs use stringified counter ids).
function bumpMax(maxId, id) {
  const n = parseInt(id, 10);
  return Number.isFinite(n) && n > maxId ? n : maxId;
}

// Rebuild the in-memory object from a doc: drop Mongo bookkeeping fields,
// re-assert id (string) so write-through keying keeps working.
function docToItem(doc) {
  const { _id, updatedAt, ...item } = doc;
  item.id = String(_id);
  return item;
}

async function resume(client) {
  if (!pfdb.isReady()) return;
  try {
    const { parties, carries } = await pfdb.loadAll();
    let maxId = 0;
    let restoredParties = 0;
    let restoredCarries = 0;

    for (const doc of parties) {
      const id = String(doc._id);
      maxId = bumpMax(maxId, id); // count EVERY doc toward the high-water mark
      try {
        const party = docToItem(doc);
        // Defensive: closed docs are normally deleted at close; a full party is
        // already locked on Discord (components stripped). Either way there is
        // nothing to resume — drop the doc instead of rehydrating a dead card.
        if (party.closed || ps.isFull(party)) {
          pfdb.deleteParty(id).catch(() => { /* best-effort cleanup */ });
          continue;
        }
        ps.restoreParty(id, party);
        handlers.scheduleExpiry(client, 'party', id, party.channelId, party.messageId, party.expiryEpochSecs);
        restoredParties += 1;
      } catch (err) {
        console.warn(`[partyfinder/resume] Skipping unrecoverable party doc ${id}:`, err?.message || err);
      }
    }

    for (const doc of carries) {
      const id = String(doc._id);
      maxId = bumpMax(maxId, id);
      try {
        const req = docToItem(doc);
        if (req.closed) {
          pfdb.deleteCarry(id).catch(() => { /* best-effort cleanup */ });
          continue;
        }
        ps.restoreCarryRequest(id, req);
        handlers.scheduleExpiry(client, 'carry', id, req.channelId, req.messageId, req.expiryEpochSecs);
        restoredCarries += 1;
      } catch (err) {
        console.warn(`[partyfinder/resume] Skipping unrecoverable carry doc ${id}:`, err?.message || err);
      }
    }

    // Must happen before any new party/carry is created (we are still inside
    // the ready handler, so no interaction has been processed yet).
    ps.restoreIdCounter(maxId);

    console.log(
      `[partyfinder/resume] Restored ${restoredParties} party card(s) + ${restoredCarries} carry card(s); ` +
      `id counter set to ${maxId}. Expiry timers re-armed (already-expired cards close immediately).`,
    );
  } catch (err) {
    console.warn('[partyfinder/resume] Resume failed — starting with empty in-memory state (v1 behavior):', err?.message || err);
  }
}

module.exports = { resume };
