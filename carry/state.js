// ---------------------------------------------------------------------------
// Carry sales — seat claim / release, and the in-process fast path.
//
// READ THIS FIRST, BECAUSE IT IS THE OPPOSITE OF partyfinder/state.js:
//
// partyfinder/state.js holds ACTIVE_PARTIES / ACTIVE_CARRY_REQUESTS Maps that
// ARE the truth for the running process, and mirrors them to Mongo
// fire-and-forget. THERE IS NO SUCH MAP HERE. Seat state lives in Mongo and
// only in Mongo (carry/db.js). This module owns three things and none of them
// is seat truth:
//
//   1. PENDING_DRAFTS — a half-finished purchase (tier/run/IGN chosen, payment
//      method not yet picked). NO SEAT IS CLAIMED during this window, so losing
//      it to a restart costs the buyer a re-click and nothing else. Same
//      short-lived bridge pattern as partyfinder's PENDING_DETAILS.
//
//   2. RELEASE_TIMERS — one setTimeout per live hold. Timers never survive a
//      restart; carry/resume.js re-arms them from `pendingUntil` in Mongo, and
//      the release itself is conditional, so a timer is only ever an optimisation
//      over "the DB already knows when this expires".
//
//   3. IN_FLIGHT — the in-process guard, kept from partyfinder/handlers.js:722.
//      See claimSeat() below.
// ---------------------------------------------------------------------------

const db = require('./db');
const {
  SEAT_STATUS,
  PENDING_HOLD_MS,
  DRAFT_TTL_MS,
} = require('./constants');

// ---------------------------------------------------------------------------
// 1. Purchase drafts — userId -> { runId, seatIndex, tierKey, ign, heardFrom, ... }
//
// `heardFrom` is null for a modal submitted across the 2026-09-02 deploy that
// added the field; the draft carries the null through rather than dropping it,
// so the booking records "asked but not answerable" instead of nothing.
// ---------------------------------------------------------------------------
const PENDING_DRAFTS = new Map();

function setDraft(userId, draft) {
  PENDING_DRAFTS.set(userId, { ...draft, createdAt: Date.now() });
}

// Returns the draft only if it is fresh AND matches the run/seat the click
// claims to be for. A stale draft from an abandoned flow can therefore never be
// applied to a different purchase.
function getDraft(userId, { runId, seatIndex } = {}) {
  const draft = PENDING_DRAFTS.get(userId);
  if (!draft) return null;
  if (Date.now() - draft.createdAt > DRAFT_TTL_MS) {
    PENDING_DRAFTS.delete(userId);
    return null;
  }
  if (runId !== undefined && draft.runId !== runId) return null;
  if (seatIndex !== undefined && draft.seatIndex !== seatIndex) return null;
  return draft;
}

function clearDraft(userId) {
  PENDING_DRAFTS.delete(userId);
}

// ---------------------------------------------------------------------------
// 2. Release timers — bookingId -> Timeout
// ---------------------------------------------------------------------------
const RELEASE_TIMERS = new Map();

// onFire is injected (handlers.js) so state.js never imports handlers — that
// would be a require cycle, and resume.js already depends on both.
function armRelease(bookingId, pendingUntil, onFire) {
  cancelRelease(bookingId);
  const delayMs = Math.max(0, new Date(pendingUntil).getTime() - Date.now());
  const timer = setTimeout(() => {
    RELEASE_TIMERS.delete(bookingId);
    Promise.resolve()
      .then(() => onFire(bookingId))
      .catch(err => console.warn(`[carry/state] Auto-release for ${bookingId} failed:`, err?.message || err));
  }, delayMs);
  // Don't hold the process open for a pending hold.
  if (typeof timer.unref === 'function') timer.unref();
  RELEASE_TIMERS.set(bookingId, timer);
  return delayMs;
}

function cancelRelease(bookingId) {
  const timer = RELEASE_TIMERS.get(bookingId);
  if (timer) {
    clearTimeout(timer);
    RELEASE_TIMERS.delete(bookingId);
  }
}

function armedReleaseCount() {
  return RELEASE_TIMERS.size;
}

// ---------------------------------------------------------------------------
// 3. Seat selection.
//
// There is no seat picker in the buyer flow (spec §7) — the seat is assigned:
// LOWEST OPEN SEAT FIRST.
//
// EVERY SEAT IS OPEN TO EVERY CLASS (Conrad, 2026-08-31). The class-gated
// Priest seat is gone, and with it the self-declaration step and the
// wrong-class refusal — so the only reason this can fail is a full run, and
// the buyer's roles are never consulted.
//
// `priestOnly` is deliberately NOT consulted. Runs created before the change
// still carry it on their last seat; ignoring it is what makes that seat
// sellable to anyone without a migration.
//
// Returns one of:
//   { ok: true,  seatIndex }
//   { ok: false, reason: 'full' }
// ---------------------------------------------------------------------------
function selectSeat(run) {
  const open = run.seats
    .filter(s => s.status === SEAT_STATUS.OPEN)
    .sort((a, b) => a.index - b.index);
  if (!open.length) return { ok: false, reason: 'full' };
  return { ok: true, seatIndex: open[0].index };
}

// ---------------------------------------------------------------------------
// 4. The claim.
//
// THE IN-PROCESS GUARD (kept from partyfinder/handlers.js:722): the `has` check
// and the `add` below are adjacent SYNCHRONOUS statements with NO `await`
// between them. Node runs them as one uninterruptible unit, so two clicks
// landing in the same tick cannot both pass. That is still the right fast path
// and it is free.
//
// THE AUTHORITATIVE GUARD is the conditional update inside db.claimSeat: it
// asserts the seat is still open and reports matchedCount === 0 if it wasn't.
// The in-process guard alone would be wrong here, because Railway can restart
// mid-purchase and could in principle run more than one instance — the process
// is not the boundary that matters when money is involved.
// ---------------------------------------------------------------------------
const IN_FLIGHT = new Set();

function seatKey(runId, seatIndex) {
  return `${runId}#${seatIndex}`;
}

/**
 * Claim a seat and open the booking ledger entry for it.
 *
 * @returns {Promise<{ok: true, booking: object} | {ok: false, reason: 'taken'|'store'}>}
 */
async function claimSeat({
  run, seatIndex,
  userId, username, displayName, ign, heardFrom = null, paymentMethod, guildId,
}) {
  const key = seatKey(run._id, seatIndex);

  // --- in-process fast path: check and take, no await between ---------------
  if (IN_FLIGHT.has(key)) return { ok: false, reason: 'taken' };
  IN_FLIGHT.add(key);
  // -------------------------------------------------------------------------

  try {
    const pendingUntil = new Date(Date.now() + PENDING_HOLD_MS);

    // The ledger entry is written BEFORE the seat is taken, so a crash between
    // the two leaves a recoverable booking rather than a seat held by nothing.
    // If the take then fails the booking is transitioned to `released` — the
    // record survives (spec §4.2), it just never occupied a seat.
    const booking = await db.createBooking({
      runId: run._id,
      runNumber: run.number,
      tier: run.tier,
      priceUsd: run.priceUsd,
      seatIndex,
      guildId,
      userId,
      username,
      displayName,
      ign,
      heardFrom,
      paymentMethod,
      pendingUntil,
    });
    if (!booking) return { ok: false, reason: 'store' };

    const won = await db.claimSeat({
      runId: run._id,
      seatIndex,
      bookingId: booking._id,
      userId,
      displayName,
      ign,
      heardFrom,
    });

    if (!won) {
      // Somebody else got there first. Close the ledger entry out honestly
      // rather than deleting it.
      await db.markBookingReleased(booking._id).catch(() => { /* best effort */ });
      return { ok: false, reason: 'taken' };
    }

    return { ok: true, booking };
  } finally {
    IN_FLIGHT.delete(key);
  }
}

// Test hook — clear the in-process guard and the draft/timer maps between
// simulated runs. Never used at runtime.
function _resetForTests() {
  IN_FLIGHT.clear();
  PENDING_DRAFTS.clear();
  for (const timer of RELEASE_TIMERS.values()) clearTimeout(timer);
  RELEASE_TIMERS.clear();
}

module.exports = {
  // drafts
  setDraft,
  getDraft,
  clearDraft,
  // timers
  armRelease,
  cancelRelease,
  armedReleaseCount,
  // seat selection
  selectSeat,
  // the claim
  claimSeat,
  seatKey,
  // exported for tests / simulation
  _resetForTests,
  _inFlight: IN_FLIGHT,
};
