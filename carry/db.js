// ---------------------------------------------------------------------------
// Final Mirage carry-sales persistence — MongoDB Atlas via the native driver.
//
// Own MongoClient — does NOT share the kudos/quiz/membersync/roster/officerapp/
// rodb/activitycampaign/gvg/reactionrole/partyfinder/ticket clients. Same Atlas
// cluster, same MONGODB_URI, separate MongoClient instance so a failure in one
// subsystem doesn't bleed into another. This is the house pattern.
//
// ===========================================================================
// DEPARTURE 1 FROM /partyfinder (spec §4.1): MONGO IS AUTHORITATIVE.
//
// partyfinder/state.js keeps an in-memory Map authoritative and mirrors to
// Mongo fire-and-forget. Correct trade for free party-finding; wrong one here.
// Railway restarts on every deploy, and a mirror that lagged means a seat sold
// twice and a refund owed.
//
// Here the seat is claimed by ONE CONDITIONAL UPDATE that asserts the seat is
// still open and fails if it isn't (claimSeat below). matchedCount === 0 means
// somebody else took it. The DATABASE enforces capacity, so a deploy
// mid-purchase cannot double-sell and the design does not break if Railway
// ever runs more than one instance. There is no in-memory seat map at all.
//
// DEPARTURE 2 (spec §4.2): BOOKINGS ARE A PERMANENT LEDGER.
//
// partyfinder/db.js DELETES party docs on close. Right for throwaway cards,
// wrong for sales records. NOTHING IN carry_bookings IS EVER DELETED. Releases,
// cancellations and run deletions are STATUS TRANSITIONS with timestamps,
// appended to a `history` array. That also gives per-run and per-period revenue
// reporting for free later.
// ===========================================================================
//
// Graceful degradation: if MONGODB_URI is missing or Atlas is unreachable the
// bot boots fully, isReady() returns false, and every carry surface says so
// instead of erroring. initSchema() never throws to the boot path. Unlike
// partyfinder there is NO degraded in-memory mode — selling seats without a
// durable record is exactly the failure this feature exists to avoid, so the
// feature simply refuses to trade until the store is back.
//
// Collections (db `discordbot`) — new + isolated to this feature:
//
//   carry_runs — one doc per run:
//     {
//       _id: 'carryrun:0007', number: 7,
//       guildId, tier: 'SS'|'SSS', priceUsd, slots,
//       startAt: Date, startEpochSecs: number,
//       status: 'open'|'closed'|'concluded'|'deleted',
//       seats: [ { index, priestOnly, status: 'open'|'pending'|'paid',
//                  bookingId, userId, displayName, ign, declaredPriest } ],
//       boardChannelId, boardMessageId,
//       createdBy, createdAt, updatedAt,
//       closedBy, closedAt, deletedBy, deletedAt
//     }
//
//   carry_bookings — one doc per booking, APPEND-ONLY IN SPIRIT:
//     {
//       _id: 'carrybooking:000042', number: 42,
//       runId, runNumber, tier, priceUsd, seatIndex, priestSeat,
//       guildId, userId, username, displayName, ign,
//       declaredPriest,      — buyer self-declared Priest (no class role held)
//       priestRoleVerified,  — held the Priest role at booking time
//       paymentMethod,
//       status: 'pending'|'paid'|'completed'|'released'|'cancelled'|'run_deleted',
//       pendingUntil: Date,
//       history: [ { status, at, by } ],
//       pendingChannelId, pendingMessageId,
//       paidBy, paidAt, releasedAt, cancelledBy, cancelledAt, cancelReason,
//       runDeletedBy, runDeletedAt,
//       createdAt, updatedAt
//     }
//
//   carry_counters — { _id: 'runNumber'|'bookingNumber', seq: <int> }
// ---------------------------------------------------------------------------

const { MongoClient } = require('mongodb');

const {
  SEAT_STATUS,
  BOOKING_STATUS,
  OCCUPYING_BOOKING_STATUSES,
  RUN_STATUS,
} = require('./constants');

const DB_NAME = 'discordbot';
const RUNS_COLLECTION = 'carry_runs';
const BOOKINGS_COLLECTION = 'carry_bookings';
const COUNTERS_COLLECTION = 'carry_counters';

const RUN_COUNTER_ID = 'runNumber';
const BOOKING_COUNTER_ID = 'bookingNumber';

let client = null;
let runsCol = null;
let bookingsCol = null;
let countersCol = null;
let connected = false;

const uri = process.env.MONGODB_URI;

if (uri) {
  client = new MongoClient(uri, {
    serverSelectionTimeoutMS: 10_000,
    connectTimeoutMS: 10_000,
  });
} else {
  console.warn('[carry/db] MONGODB_URI not set — carry sales disabled (bot still running).');
}

function isReady() {
  return connected && runsCol !== null && bookingsCol !== null && countersCol !== null;
}

// ---------------------------------------------------------------------------
// Connect + idempotent index creation. Called once from ready.js boot.
// Returns true on success, false if disabled/unreachable (never throws).
// ---------------------------------------------------------------------------
async function initSchema() {
  if (!client) return false;
  try {
    await client.connect();
    const db = client.db(DB_NAME);
    runsCol = db.collection(RUNS_COLLECTION);
    bookingsCol = db.collection(BOOKINGS_COLLECTION);
    countersCol = db.collection(COUNTERS_COLLECTION);

    // { status, tier, startAt } backs the timeslot picker (open runs of a tier,
    // soonest first) — hit on every purchase.
    await runsCol.createIndex({ status: 1, tier: 1, startAt: 1 });
    // { status, startAt } backs the boot-time conclude sweep.
    await runsCol.createIndex({ status: 1, startAt: 1 });
    // { status, pendingUntil } backs the pending-hold re-arm on boot.
    await bookingsCol.createIndex({ status: 1, pendingUntil: 1 });
    // { runId, status } backs the paid-booking guard on /carryrun delete.
    await bookingsCol.createIndex({ runId: 1, status: 1 });
    // { userId, status } backs per-buyer lookups and future reporting.
    await bookingsCol.createIndex({ userId: 1, status: 1 });

    connected = true;
    console.log('[carry/db] Connected to MongoDB — carry sales store ready.');
    return true;
  } catch (err) {
    connected = false;
    runsCol = null;
    bookingsCol = null;
    countersCol = null;
    console.warn('[carry/db] MongoDB connect/index init failed — carry sales disabled:', err?.message || err);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Id allocation. findOneAndUpdate with $inc is ATOMIC server-side, so two
// concurrent creates cannot be handed the same number.
// ---------------------------------------------------------------------------
async function nextSeq(counterId) {
  if (!isReady()) return null;
  const res = await countersCol.findOneAndUpdate(
    { _id: counterId },
    { $inc: { seq: 1 } },
    { upsert: true, returnDocument: 'after' },
  );
  // Driver v6 returns the doc directly; older shapes nest it under `.value`.
  const doc = res?.value ?? res;
  return doc?.seq ?? null;
}

function runIdFor(number) {
  return `carryrun:${String(number).padStart(4, '0')}`;
}

function bookingIdFor(number) {
  return `carrybooking:${String(number).padStart(6, '0')}`;
}

// ---------------------------------------------------------------------------
// Runs.
// ---------------------------------------------------------------------------

// Seats are derived from the tier, never passed in — capacity and the Priest
// seat cannot drift from the spec (§6).
function buildSeats(tier) {
  const seats = [];
  for (let i = 0; i < tier.slots; i++) {
    seats.push({
      index: i,
      priestOnly: i === tier.priestSeatIndex,
      status: SEAT_STATUS.OPEN,
      bookingId: null,
      userId: null,
      displayName: null,
      ign: null,
      declaredPriest: false,
    });
  }
  return seats;
}

async function createRun({ tier, startAt, guildId, createdBy }) {
  if (!isReady()) return null;
  const number = await nextSeq(RUN_COUNTER_ID);
  if (number == null) return null;

  const now = new Date();
  const doc = {
    _id: runIdFor(number),
    number,
    guildId: guildId || null,
    tier: tier.key,
    priceUsd: tier.priceUsd,
    slots: tier.slots,
    startAt,
    startEpochSecs: Math.floor(startAt.getTime() / 1000),
    status: RUN_STATUS.OPEN,
    seats: buildSeats(tier),
    boardChannelId: null,
    boardMessageId: null,
    createdBy: createdBy || null,
    createdAt: now,
    updatedAt: now,
    closedBy: null, closedAt: null,
    deletedBy: null, deletedAt: null,
  };
  await runsCol.insertOne(doc);
  return doc;
}

async function getRun(runId) {
  if (!isReady()) return null;
  return runsCol.findOne({ _id: runId });
}

// Every run that still has a board message on Discord — everything but deleted.
async function listLiveRuns() {
  if (!isReady()) return [];
  return runsCol
    .find({ status: { $ne: RUN_STATUS.DELETED } })
    .sort({ startAt: 1 })
    .toArray();
}

// Open runs of a tier, soonest first. FULL RUNS ARE FILTERED OUT HERE (spec
// §7.3) so a full run cannot be picked in the first place; the conditional take
// in claimSeat is the backstop for the race, not the primary guard.
async function listOpenRunsForTier(tierKey, { now = new Date() } = {}) {
  if (!isReady()) return [];
  const runs = await runsCol
    .find({ status: RUN_STATUS.OPEN, tier: tierKey, startAt: { $gt: now } })
    .sort({ startAt: 1 })
    .toArray();
  return runs.filter(run => run.seats.some(s => s.status === SEAT_STATUS.OPEN));
}

// Open runs whose start time has passed — restyled as concluded on boot and by
// the conclude sweep. The board message is LEFT IN PLACE (spec §6).
async function listRunsDueToConclude({ now = new Date() } = {}) {
  if (!isReady()) return [];
  return runsCol
    .find({ status: { $in: [RUN_STATUS.OPEN, RUN_STATUS.CLOSED] }, startAt: { $lte: now } })
    .toArray();
}

async function updateRun(runId, fields) {
  if (!isReady()) return null;
  await runsCol.updateOne({ _id: runId }, { $set: { ...fields, updatedAt: new Date() } });
  return runsCol.findOne({ _id: runId });
}

async function setRunBoardMessage(runId, channelId, messageId) {
  return updateRun(runId, { boardChannelId: channelId, boardMessageId: messageId });
}

// Conditional so a double-click can't report success twice.
async function closeRun(runId, officerId) {
  if (!isReady()) return false;
  const res = await runsCol.updateOne(
    { _id: runId, status: RUN_STATUS.OPEN },
    { $set: { status: RUN_STATUS.CLOSED, closedBy: officerId, closedAt: new Date(), updatedAt: new Date() } },
  );
  return res.matchedCount === 1;
}

async function concludeRun(runId) {
  if (!isReady()) return false;
  const res = await runsCol.updateOne(
    { _id: runId, status: { $in: [RUN_STATUS.OPEN, RUN_STATUS.CLOSED] } },
    { $set: { status: RUN_STATUS.CONCLUDED, updatedAt: new Date() } },
  );
  return res.matchedCount === 1;
}

// The run doc itself is NOT deleted — it is tombstoned, because every booking
// in the ledger points at it and a dangling runId would make the ledger
// unreadable. Only the Discord board message goes away (handlers).
async function markRunDeleted(runId, officerId) {
  if (!isReady()) return false;
  const res = await runsCol.updateOne(
    { _id: runId, status: { $ne: RUN_STATUS.DELETED } },
    {
      $set: {
        status: RUN_STATUS.DELETED,
        deletedBy: officerId,
        deletedAt: new Date(),
        updatedAt: new Date(),
      },
    },
  );
  return res.matchedCount === 1;
}

async function rescheduleRun(runId, startAt) {
  if (!isReady()) return null;
  const current = await getRun(runId);
  if (!current) return null;

  const fields = {
    startAt,
    startEpochSecs: Math.floor(startAt.getTime() / 1000),
  };
  // A reschedule REOPENS a run that had only concluded because its old start
  // time passed — moving it to next week should put it back on sale. A run an
  // officer CLOSED by hand stays closed; that was a deliberate act and a
  // reschedule is not a reversal of it.
  if (current.status === RUN_STATUS.CONCLUDED && startAt.getTime() > Date.now()) {
    fields.status = RUN_STATUS.OPEN;
  }
  return updateRun(runId, fields);
}

// ===========================================================================
// THE CONDITIONAL TAKE (spec §4.1). This is the load-bearing function of the
// whole feature.
//
// The filter asserts BOTH that the run is still open AND that this exact seat
// is still open. If either is false the update matches nothing, matchedCount is
// 0, and the caller tells the buyer they were beaten to it and re-renders the
// run's TRUE state. Two buyers taking the last seat at the same instant: the
// database picks the winner, not the process.
// ===========================================================================
async function claimSeat({ runId, seatIndex, bookingId, userId, displayName, ign, declaredPriest }) {
  if (!isReady()) return false;
  const res = await runsCol.updateOne(
    {
      _id: runId,
      status: RUN_STATUS.OPEN,
      [`seats.${seatIndex}.status`]: SEAT_STATUS.OPEN,
    },
    {
      $set: {
        [`seats.${seatIndex}.status`]: SEAT_STATUS.PENDING,
        [`seats.${seatIndex}.bookingId`]: bookingId,
        [`seats.${seatIndex}.userId`]: userId,
        [`seats.${seatIndex}.displayName`]: displayName,
        [`seats.${seatIndex}.ign`]: ign,
        [`seats.${seatIndex}.declaredPriest`]: Boolean(declaredPriest),
        updatedAt: new Date(),
      },
    },
  );
  return res.matchedCount === 1;
}

// pending -> paid. Conditional on the seat still holding THIS booking, so a
// Mark Paid that arrives after the hold auto-released (and the seat was resold)
// cannot overwrite the new occupant. See spec §11.
async function confirmSeatPaid(runId, seatIndex, bookingId) {
  if (!isReady()) return false;
  const res = await runsCol.updateOne(
    {
      _id: runId,
      [`seats.${seatIndex}.status`]: SEAT_STATUS.PENDING,
      [`seats.${seatIndex}.bookingId`]: bookingId,
    },
    { $set: { [`seats.${seatIndex}.status`]: SEAT_STATUS.PAID, updatedAt: new Date() } },
  );
  return res.matchedCount === 1;
}

// Vacate a seat back to open. Conditional on the seat still holding THIS
// booking — the same guard as above, and the reason a late auto-release timer
// can't evict a buyer who was already confirmed and then resold to.
// `fromStatuses` narrows it further: the expiry timer passes ['pending'] so it
// can never release a seat an officer just marked paid.
async function vacateSeat(runId, seatIndex, bookingId, fromStatuses = [SEAT_STATUS.PENDING, SEAT_STATUS.PAID]) {
  if (!isReady()) return false;
  const res = await runsCol.updateOne(
    {
      _id: runId,
      [`seats.${seatIndex}.status`]: { $in: fromStatuses },
      [`seats.${seatIndex}.bookingId`]: bookingId,
    },
    {
      $set: {
        [`seats.${seatIndex}.status`]: SEAT_STATUS.OPEN,
        [`seats.${seatIndex}.bookingId`]: null,
        [`seats.${seatIndex}.userId`]: null,
        [`seats.${seatIndex}.displayName`]: null,
        [`seats.${seatIndex}.ign`]: null,
        [`seats.${seatIndex}.declaredPriest`]: false,
        updatedAt: new Date(),
      },
    },
  );
  return res.matchedCount === 1;
}

// ---------------------------------------------------------------------------
// Bookings — the ledger. Nothing here ever deletes.
// ---------------------------------------------------------------------------

async function createBooking(data) {
  if (!isReady()) return null;
  const number = await nextSeq(BOOKING_COUNTER_ID);
  if (number == null) return null;

  const now = new Date();
  const doc = {
    _id: bookingIdFor(number),
    number,
    runId:       data.runId,
    runNumber:   data.runNumber,
    tier:        data.tier,
    priceUsd:    data.priceUsd,
    seatIndex:   data.seatIndex,
    priestSeat:  Boolean(data.priestSeat),
    guildId:     data.guildId || null,
    userId:      data.userId,
    username:    data.username,
    displayName: data.displayName,
    ign:         data.ign,
    declaredPriest:     Boolean(data.declaredPriest),
    priestRoleVerified: Boolean(data.priestRoleVerified),
    paymentMethod: data.paymentMethod,
    status:      BOOKING_STATUS.PENDING,
    pendingUntil: data.pendingUntil,
    history: [{ status: BOOKING_STATUS.PENDING, at: now, by: data.userId }],
    pendingChannelId: null,
    pendingMessageId: null,
    paidBy: null, paidAt: null,
    releasedAt: null,
    cancelledBy: null, cancelledAt: null, cancelReason: null,
    runDeletedBy: null, runDeletedAt: null,
    createdAt: now,
    updatedAt: now,
  };
  await bookingsCol.insertOne(doc);
  return doc;
}

async function getBooking(bookingId) {
  if (!isReady()) return null;
  return bookingsCol.findOne({ _id: bookingId });
}

// Every still-pending hold — used by the boot-time re-arm (resume.js).
async function listPendingBookings() {
  if (!isReady()) return [];
  return bookingsCol.find({ status: BOOKING_STATUS.PENDING }).toArray();
}

async function listBookingsForRun(runId) {
  if (!isReady()) return [];
  return bookingsCol.find({ runId }).sort({ number: 1 }).toArray();
}

// The /carryrun delete guard (spec §6.1). A run with any PAID booking is
// people who have handed over money; deletion is refused with this count.
async function countPaidBookingsForRun(runId) {
  if (!isReady()) return 0;
  return bookingsCol.countDocuments({
    runId,
    status: { $in: [BOOKING_STATUS.PAID, BOOKING_STATUS.COMPLETED] },
  });
}

async function setBookingPendingMessage(bookingId, channelId, messageId) {
  if (!isReady()) return null;
  await bookingsCol.updateOne(
    { _id: bookingId },
    { $set: { pendingChannelId: channelId, pendingMessageId: messageId, updatedAt: new Date() } },
  );
  return bookingsCol.findOne({ _id: bookingId });
}

// ---------------------------------------------------------------------------
// Status transitions. Every one of them is CONDITIONAL on the current status
// and appends to `history` — so the ledger records not just where a booking
// ended up but how it got there, and two officers clicking at once cannot both
// win. NONE of them delete.
// ---------------------------------------------------------------------------
async function transition(bookingId, fromStatuses, toStatus, fields, by) {
  if (!isReady()) return false;
  const now = new Date();
  const res = await bookingsCol.updateOne(
    { _id: bookingId, status: { $in: fromStatuses } },
    {
      $set: { status: toStatus, ...fields, updatedAt: now },
      $push: { history: { status: toStatus, at: now, by: by || null } },
    },
  );
  return res.matchedCount === 1;
}

async function markBookingPaid(bookingId, officerId) {
  return transition(
    bookingId,
    [BOOKING_STATUS.PENDING],
    BOOKING_STATUS.PAID,
    { paidBy: officerId, paidAt: new Date() },
    officerId,
  );
}

async function markBookingReleased(bookingId) {
  return transition(
    bookingId,
    [BOOKING_STATUS.PENDING],
    BOOKING_STATUS.RELEASED,
    { releasedAt: new Date() },
    null,
  );
}

async function markBookingCancelled(bookingId, officerId, reason) {
  return transition(
    bookingId,
    [BOOKING_STATUS.PENDING, BOOKING_STATUS.PAID],
    BOOKING_STATUS.CANCELLED,
    { cancelledBy: officerId, cancelledAt: new Date(), cancelReason: reason || null },
    officerId,
  );
}

async function markBookingCompleted(bookingId, officerId) {
  return transition(bookingId, [BOOKING_STATUS.PAID], BOOKING_STATUS.COMPLETED, {}, officerId);
}

// Run deleted (spec §6.1). Bookings are RETAINED and marked.
//
// Only bookings that were still live (pending) change status — a booking that
// already ended as released or cancelled keeps that terminal truth, because
// overwriting it would falsify the ledger about how it ended. Every booking for
// the run, terminal or not, gets the runDeleted* stamp so the record still says
// the run went away.
async function markBookingsRunDeleted(runId, officerId) {
  if (!isReady()) return { transitioned: 0, stamped: 0 };
  const now = new Date();

  const live = await bookingsCol.updateMany(
    { runId, status: { $in: OCCUPYING_BOOKING_STATUSES } },
    {
      $set: {
        status: BOOKING_STATUS.RUN_DELETED,
        runDeletedBy: officerId, runDeletedAt: now, updatedAt: now,
      },
      $push: { history: { status: BOOKING_STATUS.RUN_DELETED, at: now, by: officerId || null } },
    },
  );

  const stamped = await bookingsCol.updateMany(
    { runId, runDeletedAt: null },
    { $set: { runDeletedBy: officerId, runDeletedAt: now, updatedAt: now } },
  );

  return { transitioned: live.modifiedCount, stamped: stamped.modifiedCount };
}

// ---------------------------------------------------------------------------
// Reporting support. The ledger makes this free (spec §4.2); no command is
// built on it yet (spec §12).
// ---------------------------------------------------------------------------
async function revenueSummary({ since = null, until = null } = {}) {
  if (!isReady()) return { count: 0, totalUsd: 0 };
  const q = { status: { $in: [BOOKING_STATUS.PAID, BOOKING_STATUS.COMPLETED] } };
  if (since || until) {
    q.paidAt = {};
    if (since) q.paidAt.$gte = since;
    if (until) q.paidAt.$lte = until;
  }
  const docs = await bookingsCol.find(q).toArray();
  return {
    count: docs.length,
    totalUsd: docs.reduce((sum, d) => sum + (d.priceUsd || 0), 0),
  };
}

async function close() {
  if (client) {
    try { await client.close(); } catch { /* ignore */ }
  }
  connected = false;
}

// Test hook — inject in-memory fake collections so the conditional take, the
// expiry path and the delete guard can be exercised without touching Atlas.
// Mirrors partyfinder/db.js:_setCollectionsForTests. Never used at runtime.
function _setCollectionsForTests(fakeRuns, fakeBookings, fakeCounters) {
  runsCol = fakeRuns || null;
  bookingsCol = fakeBookings || null;
  countersCol = fakeCounters || null;
  connected = Boolean(fakeRuns && fakeBookings && fakeCounters);
}

module.exports = {
  isReady,
  initSchema,
  runIdFor,
  bookingIdFor,
  buildSeats,
  // runs
  createRun,
  getRun,
  listLiveRuns,
  listOpenRunsForTier,
  listRunsDueToConclude,
  updateRun,
  setRunBoardMessage,
  closeRun,
  concludeRun,
  markRunDeleted,
  rescheduleRun,
  // seats — the conditional take
  claimSeat,
  confirmSeatPaid,
  vacateSeat,
  // bookings — the ledger
  createBooking,
  getBooking,
  listPendingBookings,
  listBookingsForRun,
  countPaidBookingsForRun,
  setBookingPendingMessage,
  markBookingPaid,
  markBookingReleased,
  markBookingCancelled,
  markBookingCompleted,
  markBookingsRunDeleted,
  revenueSummary,
  close,
  // exported for tests / simulation
  _setCollectionsForTests,
};
