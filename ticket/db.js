// ---------------------------------------------------------------------------
// Guild support ticket persistence — MongoDB Atlas via the native driver.
//
// Own MongoClient — does NOT share the kudos/quiz/membersync/roster/officerapp/
// rodb/activitycampaign clients. Same Atlas cluster, same MONGODB_URI, separate
// MongoClient instance so a failure in one subsystem doesn't bleed into another.
// This is the house pattern (see activitycampaign/db.js:6-10).
//
// Graceful degradation: if MONGODB_URI is missing or Atlas is unreachable, the
// bot still boots fully. isReady() returns false; /guildsupport replies
// "unavailable", Open Ticket is refused ephemerally, and the sticky engine
// no-ops. initSchema() never throws to the boot path.
//
// THIS COLLECTION IS THE SOURCE OF TRUTH. Everything the feature knows lives
// here; the in-memory sticky Map is a cache that is rebuilt from these docs on
// every ready. Nothing about a ticket is held only in memory.
//
// Collections (db `discordbot`) — both new + isolated to this feature:
//
//   tickets — one doc per ticket:
//     {
//       _id:              'ticket:0042',
//       number:           42,
//       guildId, userId, username, displayName: string,
//       rolesSnapshot:    [{ id, name }],   — roles AT SUBMIT TIME (see below)
//       joinedAt:         Date|null,
//       accountCreatedAt: Date,
//       subject, message: string,
//       status:           'open'|'accepted'|'resolved'|'declined'|'orphaned',
//       reviewChannelId, reviewMessageId: string|null,  — the officer embed
//       channelId:        string|null,      — the private channel, once accepted
//       stickyMessageId:  string|null,
//       acceptedBy, acceptedAt,
//       resolvedBy, resolvedAt,
//       declinedBy, declinedAt, declineReason,
//       transcriptMessageId: string|null,
//       deleteAfter:      Date|null,        — set on resolve; swept later
//       createdAt, updatedAt: Date,
//     }
//
//   ticket_counters — { _id: 'ticketNumber', seq: <int> }
//
// WHY rolesSnapshot IS STORED rather than read live: the embed must show what
// the member held when they asked. Somebody promoted or demoted mid-ticket
// should not silently rewrite the record an officer is reading.
// ---------------------------------------------------------------------------

const { MongoClient } = require('mongodb');

const DB_NAME = 'discordbot';
const TICKETS_COLLECTION = 'tickets';
const COUNTERS_COLLECTION = 'ticket_counters';
const COUNTER_ID = 'ticketNumber';

let client = null;
let ticketsCol = null;
let countersCol = null;
let connected = false;

const uri = process.env.MONGODB_URI;

if (uri) {
  client = new MongoClient(uri, {
    serverSelectionTimeoutMS: 10_000,
    connectTimeoutMS: 10_000,
  });
} else {
  console.warn('[ticket/db] MONGODB_URI not set — ticket system disabled (bot still running).');
}

function isReady() {
  return connected && ticketsCol !== null && countersCol !== null;
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
    ticketsCol = db.collection(TICKETS_COLLECTION);
    countersCol = db.collection(COUNTERS_COLLECTION);

    // { userId, status } backs the one-open-ticket guard, hit on every submit.
    await ticketsCol.createIndex({ userId: 1, status: 1 });
    // { channelId } backs sticky lookups and the resume pass.
    await ticketsCol.createIndex({ channelId: 1 });
    // { status, deleteAfter } backs the delete sweeper.
    await ticketsCol.createIndex({ status: 1, deleteAfter: 1 });

    connected = true;
    console.log('[ticket/db] Connected to MongoDB — ticket store ready.');
    return true;
  } catch (err) {
    connected = false;
    ticketsCol = null;
    countersCol = null;
    console.warn('[ticket/db] MongoDB connect/index init failed — ticket system disabled:', err?.message || err);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Ticket number allocation.
//
// findOneAndUpdate with $inc is ATOMIC server-side, so two members submitting
// at the same instant cannot be handed the same number. A read-then-write would
// race here — this is the one place in the feature with genuine concurrency.
// ---------------------------------------------------------------------------
async function nextTicketNumber() {
  if (!isReady()) return null;
  const res = await countersCol.findOneAndUpdate(
    { _id: COUNTER_ID },
    { $inc: { seq: 1 } },
    { upsert: true, returnDocument: 'after' },
  );
  // Driver v6 returns the doc directly; older shapes nest it under `.value`.
  const doc = res?.value ?? res;
  return doc?.seq ?? null;
}

function ticketIdFor(number) {
  return `ticket:${String(number).padStart(4, '0')}`;
}

// ---------------------------------------------------------------------------
// Create / read.
// ---------------------------------------------------------------------------

// Written BEFORE the officer embed is posted, so a crash mid-flow leaves a
// recoverable ticket rather than a phantom embed with no record behind it.
async function createTicket(data) {
  if (!isReady()) return null;
  const number = await nextTicketNumber();
  if (number == null) return null;

  const now = new Date();
  const doc = {
    _id: ticketIdFor(number),
    number,
    guildId:          data.guildId,
    userId:           data.userId,
    username:         data.username,
    displayName:      data.displayName,
    rolesSnapshot:    data.rolesSnapshot || [],
    joinedAt:         data.joinedAt || null,
    accountCreatedAt: data.accountCreatedAt || null,
    subject:          data.subject,
    message:          data.message,
    status:           'open',
    reviewChannelId:  null,
    reviewMessageId:  null,
    channelId:        null,
    stickyMessageId:  null,
    acceptedBy: null, acceptedAt: null,
    resolvedBy: null, resolvedAt: null,
    declinedBy: null, declinedAt: null, declineReason: null,
    transcriptMessageId: null,
    deleteAfter: null,
    createdAt: now,
    updatedAt: now,
  };
  await ticketsCol.insertOne(doc);
  return doc;
}

async function getTicket(ticketId) {
  if (!isReady()) return null;
  return ticketsCol.findOne({ _id: ticketId });
}

async function getTicketByChannel(channelId) {
  if (!isReady()) return null;
  return ticketsCol.findOne({ channelId });
}

// The one-open-ticket guard. 'open' (awaiting an officer) and 'accepted'
// (channel live) both count as still-open from the member's point of view.
async function findActiveTicketForUser(userId) {
  if (!isReady()) return null;
  return ticketsCol.findOne({ userId, status: { $in: ['open', 'accepted'] } });
}

// Every accepted ticket — used by the ready-time resume to rebuild the sticky
// cache and reconcile channels that vanished while the bot was down.
async function listAcceptedTickets() {
  if (!isReady()) return [];
  return ticketsCol.find({ status: 'accepted' }).toArray();
}

// Resolved tickets whose grace period has elapsed and whose channel is still
// around. Read fresh from Mongo each sweep, so downtime just delays a deletion
// rather than losing it.
async function listChannelsDueForDeletion(now = new Date()) {
  if (!isReady()) return [];
  return ticketsCol.find({
    status: 'resolved',
    channelId: { $ne: null },
    deleteAfter: { $ne: null, $lte: now },
  }).toArray();
}

// ---------------------------------------------------------------------------
// Mutations. All of them stamp updatedAt.
// ---------------------------------------------------------------------------

async function update(ticketId, fields) {
  if (!isReady()) return null;
  await ticketsCol.updateOne(
    { _id: ticketId },
    { $set: { ...fields, updatedAt: new Date() } },
  );
  return ticketsCol.findOne({ _id: ticketId });
}

async function setReviewMessage(ticketId, channelId, messageId) {
  return update(ticketId, { reviewChannelId: channelId, reviewMessageId: messageId });
}

// Claim a ticket for acceptance. CONDITIONAL on status still being 'open', so
// two officers clicking Accept at the same moment can't both win — the second
// update matches nothing and the caller tells them who got there first.
// Returns true only if this caller made the transition.
async function claimForAccept(ticketId, officerId) {
  if (!isReady()) return false;
  const res = await ticketsCol.updateOne(
    { _id: ticketId, status: 'open' },
    { $set: { status: 'accepted', acceptedBy: officerId, acceptedAt: new Date(), updatedAt: new Date() } },
  );
  return res.modifiedCount === 1;
}

// Undo a claim when channel creation fails, so the buttons stay live and the
// ticket doesn't wedge in 'accepted' with no channel behind it.
async function releaseClaim(ticketId) {
  return update(ticketId, { status: 'open', acceptedBy: null, acceptedAt: null });
}

async function setChannel(ticketId, channelId) {
  return update(ticketId, { channelId });
}

async function setStickyMessageId(ticketId, messageId) {
  return update(ticketId, { stickyMessageId: messageId });
}

// Same conditional-transition guard as claimForAccept, for the resolve button.
async function claimForResolve(ticketId, officerId, deleteAfter) {
  if (!isReady()) return false;
  const res = await ticketsCol.updateOne(
    { _id: ticketId, status: 'accepted' },
    {
      $set: {
        status: 'resolved',
        resolvedBy: officerId,
        resolvedAt: new Date(),
        deleteAfter,
        updatedAt: new Date(),
      },
    },
  );
  return res.modifiedCount === 1;
}

async function claimForDecline(ticketId, officerId, reason) {
  if (!isReady()) return false;
  const res = await ticketsCol.updateOne(
    { _id: ticketId, status: 'open' },
    {
      $set: {
        status: 'declined',
        declinedBy: officerId,
        declinedAt: new Date(),
        declineReason: reason || null,
        updatedAt: new Date(),
      },
    },
  );
  return res.modifiedCount === 1;
}

async function setTranscriptMessageId(ticketId, messageId) {
  return update(ticketId, { transcriptMessageId: messageId });
}

// The channel is gone (deleted by us after the grace period, or manually by an
// officer). Keep the record — only drop the channel pointer.
async function clearChannel(ticketId) {
  return update(ticketId, { channelId: null, stickyMessageId: null });
}

// An accepted ticket whose channel no longer exists. Marked rather than
// deleted, so the history survives and the resume pass stops retrying it.
async function markOrphaned(ticketId) {
  return update(ticketId, { status: 'orphaned', channelId: null, stickyMessageId: null });
}

module.exports = {
  initSchema,
  isReady,
  ticketIdFor,
  createTicket,
  getTicket,
  getTicketByChannel,
  findActiveTicketForUser,
  listAcceptedTickets,
  listChannelsDueForDeletion,
  setReviewMessage,
  claimForAccept,
  releaseClaim,
  setChannel,
  setStickyMessageId,
  claimForResolve,
  claimForDecline,
  setTranscriptMessageId,
  clearChannel,
  markOrphaned,
};
