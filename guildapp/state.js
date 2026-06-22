// ---------------------------------------------------------------------------
// In-memory store for in-flight guild applications.
//
// CAVEAT: This is a process-local Map. Pending applications (the 5 modal
// answers awaiting a country selection) are LOST if the bot restarts. That is
// acceptable for v1 — an applicant whose session is dropped simply re-runs
// /guildapplication. Do NOT treat this as durable storage.
//
// Entries are keyed by the applicant's Discord user id and carry a timestamp so
// stale entries can be pruned opportunistically (see prunePending).
// ---------------------------------------------------------------------------

const PENDING_TTL_MS = 10 * 60 * 1000; // 10 minutes

// userId -> { answers: {...}, ts: <epoch ms> }
const pending = new Map();

/**
 * Opportunistic prune of entries older than the TTL. Called on each write/read
 * so the Map never grows unbounded without a background timer.
 */
function prunePending() {
  const now = Date.now();
  for (const [userId, entry] of pending) {
    if (now - entry.ts > PENDING_TTL_MS) {
      pending.delete(userId);
    }
  }
}

function setPending(userId, answers) {
  prunePending();
  pending.set(userId, { answers, ts: Date.now() });
}

function getPending(userId) {
  prunePending();
  const entry = pending.get(userId);
  return entry ? entry.answers : null;
}

function clearPending(userId) {
  pending.delete(userId);
}

module.exports = { setPending, getPending, clearPending, prunePending, PENDING_TTL_MS };
