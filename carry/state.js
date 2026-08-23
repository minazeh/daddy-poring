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
  PRIEST_ROLE_ID,
  CLASS_ROLE_IDS,
  CLASS_ROLE_BY_ID,
} = require('./constants');

// ---------------------------------------------------------------------------
// 1. Purchase drafts — userId -> { runId, seatIndex, tierKey, ign, ... }
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
// There is no seat picker in the buyer flow (spec §7) — the seat is assigned.
// The rule is: LOWEST OPEN GENERAL SEAT FIRST, and the Priest seat only when
// nothing else is left. That is what makes spec §7.4 ("Priest declaration —
// only shown when the buyer is taking the Priest seat") and spec §11
// ("non-Priest attempting the Priest seat with a class role that isn't Priest —
// refused, no self-declare path offered") describe the same moment.
//
// Returns one of:
//   { ok: true,  seatIndex, priestSeat, needsDeclaration }
//   { ok: false, reason: 'full' | 'wrong-class', className }
// ---------------------------------------------------------------------------
function classProfile(member) {
  const cache = member?.roles?.cache;
  if (!cache) return { isPriest: false, hasClassRole: false, className: null };
  const isPriest = Boolean(cache.has?.(PRIEST_ROLE_ID));
  const held = CLASS_ROLE_IDS.filter(id => cache.has?.(id));
  return {
    isPriest,
    hasClassRole: held.length > 0,
    className: held.length ? held.map(id => CLASS_ROLE_BY_ID[id] || id).join(' / ') : null,
  };
}

function selectSeat(run, profile) {
  const open = run.seats.filter(s => s.status === SEAT_STATUS.OPEN);
  if (!open.length) return { ok: false, reason: 'full' };

  const general = open.filter(s => !s.priestOnly).sort((a, b) => a.index - b.index);
  if (general.length) {
    return { ok: true, seatIndex: general[0].index, priestSeat: false, needsDeclaration: false };
  }

  // Only the Priest seat is left.
  const priestSeat = open.find(s => s.priestOnly);
  if (!priestSeat) return { ok: false, reason: 'full' };

  if (profile.isPriest) {
    return { ok: true, seatIndex: priestSeat.index, priestSeat: true, needsDeclaration: false };
  }
  if (profile.hasClassRole) {
    // They have a class role; it just isn't Priest. No self-declare path —
    // the server already knows what they are (spec §11).
    return { ok: false, reason: 'wrong-class', className: profile.className };
  }
  // No class role at all — an outside buyer. They may self-declare, and the
  // officer verifies it with the same click that confirms payment (spec §5).
  return { ok: true, seatIndex: priestSeat.index, priestSeat: true, needsDeclaration: true };
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
  run, seatIndex, priestSeat, declaredPriest, priestRoleVerified,
  userId, username, displayName, ign, paymentMethod, guildId,
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
      priestSeat,
      guildId,
      userId,
      username,
      displayName,
      ign,
      declaredPriest,
      priestRoleVerified,
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
      declaredPriest,
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
  classProfile,
  selectSeat,
  // the claim
  claimSeat,
  seatKey,
  // exported for tests / simulation
  _resetForTests,
  _inFlight: IN_FLIGHT,
};
