// ---------------------------------------------------------------------------
// Officer carry scheduler persistence — MongoDB Atlas via the native driver.
//
// Spec: docs/OFFICER_CARRY_SCHEDULER_SPEC.md §5.
//
// Own MongoClient — does NOT share the kudos/quiz/membersync/roster/officerapp/
// rodb/activitycampaign/gvg/reactionrole/partyfinder/ticket/carry clients. Same
// Atlas cluster, same MONGODB_URI, separate MongoClient instance so a failure
// in one subsystem doesn't bleed into another. This is the house pattern.
//
// ===========================================================================
// THE 3-MEMBER CAP IS ENFORCED HERE, BY THE DATABASE — NOT BY A LENGTH CHECK
// IN JAVASCRIPT.
//
// Two people pressing Join on the last free space at the same moment is a real
// race, not a theoretical one: the ephemeral select sits open for as long as
// the user takes to read it, and Railway can run more than one instance. A
// read-then-write would let both pass the check and both push, seating four
// people in a three-person slot.
//
// Instead the seat is taken by ONE CONDITIONAL updateOne whose filter asserts
// every precondition at once. matchedCount === 0 means one of them failed, and
// the caller re-reads to find out which. There is no in-memory slot map at all.
//
// NO PENDING STATE (spec §0). Nothing here holds, reserves or expires. A member
// is either in a slot or not, and the only way out is an explicit leave.
// ===========================================================================
//
// Graceful degradation: if MONGODB_URI is missing or Atlas is unreachable the
// bot boots fully, isReady() returns false, and every scheduler surface says so
// instead of erroring. initSchema() never throws to the boot path. There is no
// degraded in-memory mode — a schedule that evaporates on the next Railway
// redeploy is worse than an honest refusal.
//
// Collection (db `discordbot`) — new + isolated to this feature:
//
//   officercarry_weeks — one doc per guild per week:
//     {
//       _id: 'occarry:<guildId>:2026-W36',
//       guildId, weekKey,
//       weekStartAt: Date,   — Mon 00:00 GMT+7, stored as a true UTC instant
//       weekEndAt:   Date,   — following Mon 00:00 GMT+7, exclusive
//       status: 'active' | 'archived',
//       panelChannelId, panelMessageId,
//       slots: { '<day>:<HHMM>': { officers: [entry], members: [entry] }, ... },
//       createdAt, updatedAt, archivedAt
//     }
//
//   An entry is { userId, displayName, at: Date }.
//
// ARCHIVE, NEVER DELETE (spec §4.2). Rolling a week sets status:'archived' and
// inserts a fresh document. Nothing in this collection is ever removed, which
// leaves a real record of who ran what and costs nothing.
// ---------------------------------------------------------------------------

const { MongoClient } = require('mongodb');

const { allSlotKeys, weekKey, weekStartAt, weekEndAt, weekDocId } = require('./grid');
const { MAX_MEMBERS_PER_SLOT } = require('./constants');

const DB_NAME = 'discordbot';
const WEEKS_COLLECTION = 'officercarry_weeks';

let client = null;
let weeksCol = null;
let connected = false;

const uri = process.env.MONGODB_URI;

if (uri) {
  client = new MongoClient(uri, {
    serverSelectionTimeoutMS: 10_000,
    connectTimeoutMS: 10_000,
  });
} else {
  console.warn('[officercarry/db] MONGODB_URI not set — carry scheduler disabled (bot still running).');
}

function isReady() {
  return connected && weeksCol !== null;
}

// ---------------------------------------------------------------------------
// Connect + idempotent index creation. Called once from ready.js boot.
// Returns true on success, false if disabled/unreachable (never throws).
// ---------------------------------------------------------------------------
async function initSchema() {
  if (!client) return false;
  try {
    await client.connect();
    weeksCol = client.db(DB_NAME).collection(WEEKS_COLLECTION);

    // { guildId, status } backs every read on the hot path — the active week
    // is fetched on each panel render and each sweeper tick.
    await weeksCol.createIndex({ guildId: 1, status: 1 });
    // { status, weekEndAt } backs the sweeper's "which weeks are over" query.
    await weeksCol.createIndex({ status: 1, weekEndAt: 1 });

    connected = true;
    console.log('[officercarry/db] Connected to MongoDB — carry scheduler store ready.');
    return true;
  } catch (err) {
    connected = false;
    weeksCol = null;
    console.warn('[officercarry/db] MongoDB connect/index init failed — carry scheduler disabled:', err?.message || err);
    return false;
  }
}

// ---------------------------------------------------------------------------
// An empty grid: all 108 slots present with empty arrays.
//
// Pre-populating matters. If slots appeared only when first used, the
// conditional filters below would have to distinguish "slot absent" from "slot
// empty", and $push would need an upsert path per slot. Materialising the whole
// week once keeps every later write a single unambiguous update, and the
// document is tiny either way.
// ---------------------------------------------------------------------------
function emptySlots() {
  const slots = {};
  for (const key of allSlotKeys()) slots[key] = { officers: [], members: [] };
  return slots;
}

// ---------------------------------------------------------------------------
// Fetch the guild's active week, creating it if this is the first look of a new
// week. Upsert-on-insert so two simultaneous callers cannot create two docs.
// ---------------------------------------------------------------------------
async function getOrCreateActiveWeek(guildId, now = new Date()) {
  if (!isReady()) return null;

  const key = weekKey(now);
  const _id = weekDocId(guildId, key);
  const nowDate = new Date();

  // $setOnInsert only — an existing doc is returned untouched, so this is safe
  // to call on every interaction without clobbering live slot state.
  await weeksCol.updateOne(
    { _id },
    {
      $setOnInsert: {
        guildId,
        weekKey: key,
        weekStartAt: weekStartAt(now),
        weekEndAt: weekEndAt(now),
        status: 'active',
        panelChannelId: null,
        panelMessageId: null,
        slots: emptySlots(),
        createdAt: nowDate,
        updatedAt: nowDate,
        archivedAt: null,
      },
    },
    { upsert: true },
  );

  return weeksCol.findOne({ _id });
}

async function getActiveWeek(guildId) {
  if (!isReady()) return null;
  return weeksCol.findOne({ guildId, status: 'active' });
}

async function getWeekById(_id) {
  if (!isReady()) return null;
  return weeksCol.findOne({ _id });
}

// ---------------------------------------------------------------------------
// MEMBER JOIN — the conditional update the whole feature turns on.
//
// The filter asserts, atomically:
//   status active            the week has not rolled out from under the click
//   officers.0 exists        an officer is on the slot (spec §1: availability
//                            creates a slot; joining only ever fills one). This
//                            is in the SAME filter deliberately — it closes the
//                            window where an officer withdraws between the
//                            select opening and the user choosing from it.
//   members.<MAX-1> absent   fewer than MAX members. Index MAX-1 existing means
//                            length >= MAX, so requiring it absent caps the push.
//   members.userId $ne       not already joined (no double-join)
//
// Returns 'ok' | 'full' | 'no-officer' | 'already' | 'gone', re-reading only
// when the write did not match, so the happy path is a single round trip.
// ---------------------------------------------------------------------------
async function claimMemberSlot(weekId, key, entry) {
  if (!isReady()) return 'gone';

  const res = await weeksCol.updateOne(
    {
      _id: weekId,
      status: 'active',
      [`slots.${key}.officers.0`]: { $exists: true },
      [`slots.${key}.members.${MAX_MEMBERS_PER_SLOT - 1}`]: { $exists: false },
      [`slots.${key}.members.userId`]: { $ne: entry.userId },
    },
    {
      $push: { [`slots.${key}.members`]: entry },
      $set: { updatedAt: new Date() },
    },
  );

  if (res.matchedCount > 0) return 'ok';

  // Did not match. Work out which precondition failed so the user gets a real
  // answer rather than "something went wrong".
  const doc = await weeksCol.findOne({ _id: weekId });
  if (!doc || doc.status !== 'active') return 'gone';
  const slot = doc.slots?.[key];
  if (!slot) return 'gone';
  if (!slot.officers?.length) return 'no-officer';
  if (slot.members?.some(m => m.userId === entry.userId)) return 'already';
  if ((slot.members?.length || 0) >= MAX_MEMBERS_PER_SLOT) return 'full';
  return 'gone';
}

// Membership is asserted in the FILTER, not inferred from modifiedCount.
//
// The obvious version — pull, then return modifiedCount > 0 — is wrong, because
// the `$set: { updatedAt }` in the same update always counts as a modification.
// It would report success for someone who was never on the slot, telling them
// they had left something they had not joined. Matching on the userId first
// makes matchedCount mean exactly what the caller needs it to mean.
async function leaveMemberSlot(weekId, key, userId) {
  if (!isReady()) return false;
  const res = await weeksCol.updateOne(
    {
      _id: weekId,
      status: 'active',
      [`slots.${key}.members.userId`]: userId,
    },
    { $pull: { [`slots.${key}.members`]: { userId } }, $set: { updatedAt: new Date() } },
  );
  return res.matchedCount > 0;
}

// ---------------------------------------------------------------------------
// OFFICER AVAILABILITY — uncapped, but still guarded against a double-add so a
// double-click cannot list the same officer twice.
// ---------------------------------------------------------------------------
async function addOfficerSlot(weekId, key, entry) {
  if (!isReady()) return 'gone';

  const res = await weeksCol.updateOne(
    {
      _id: weekId,
      status: 'active',
      [`slots.${key}.officers.userId`]: { $ne: entry.userId },
    },
    {
      $push: { [`slots.${key}.officers`]: entry },
      $set: { updatedAt: new Date() },
    },
  );

  if (res.matchedCount > 0) return 'ok';

  const doc = await weeksCol.findOne({ _id: weekId });
  if (!doc || doc.status !== 'active') return 'gone';
  if (doc.slots?.[key]?.officers?.some(o => o.userId === entry.userId)) return 'already';
  return 'gone';
}

// Same reasoning as leaveMemberSlot: assert the officer is actually on the slot
// in the filter rather than reading it back out of modifiedCount.
async function removeOfficerSlot(weekId, key, userId) {
  if (!isReady()) return false;
  const res = await weeksCol.updateOne(
    {
      _id: weekId,
      status: 'active',
      [`slots.${key}.officers.userId`]: userId,
    },
    { $pull: { [`slots.${key}.officers`]: { userId } }, $set: { updatedAt: new Date() } },
  );
  return res.matchedCount > 0;
}

// ---------------------------------------------------------------------------
// Panel location. Stored so a restart can adopt the existing message instead of
// reposting (spec §6).
// ---------------------------------------------------------------------------
async function setPanel(weekId, channelId, messageId) {
  if (!isReady()) return false;
  const res = await weeksCol.updateOne(
    { _id: weekId },
    { $set: { panelChannelId: channelId, panelMessageId: messageId, updatedAt: new Date() } },
  );
  return res.matchedCount > 0;
}

/**
 * Carry the panel location from the outgoing week onto the incoming one, so the
 * board keeps its permalink across a roll instead of being reposted (spec §4.2).
 */
async function adoptPanelFrom(previousDoc, weekId) {
  if (!isReady() || !previousDoc?.panelMessageId) return false;
  return setPanel(weekId, previousDoc.panelChannelId, previousDoc.panelMessageId);
}

// ---------------------------------------------------------------------------
// Rolling the week. Archive, never delete.
// ---------------------------------------------------------------------------
async function archiveWeek(weekId) {
  if (!isReady()) return false;
  const res = await weeksCol.updateOne(
    { _id: weekId, status: 'active' },
    { $set: { status: 'archived', archivedAt: new Date(), updatedAt: new Date() } },
  );
  // modifiedCount, not matchedCount: if two sweeper ticks race, only the one
  // that actually flipped the status proceeds to create the new week.
  return res.modifiedCount > 0;
}

/**
 * Active weeks whose window has ended. The sweeper's only query.
 *
 * Driven by weekEndAt rather than by comparing week keys, so a bot that was
 * down across several boundaries still returns each stale week exactly once
 * and rolls it once (spec §4.1).
 */
async function listExpiredActiveWeeks(now = new Date()) {
  if (!isReady()) return [];
  return weeksCol.find({ status: 'active', weekEndAt: { $lte: now } }).toArray();
}

async function listActiveWeeks() {
  if (!isReady()) return [];
  return weeksCol.find({ status: 'active' }).toArray();
}

// Test hook — inject an in-memory fake collection so the conditional join, the
// officer guard and the weekly roll can be exercised without touching Atlas.
// Mirrors carry/db.js:_setCollectionsForTests and partyfinder/db.js. Never used
// at runtime.
function _setCollectionForTests(fakeWeeks) {
  weeksCol = fakeWeeks || null;
  connected = Boolean(fakeWeeks);
}

async function close() {
  try { if (client) await client.close(); } catch { /* already gone */ }
  connected = false;
  weeksCol = null;
}

module.exports = {
  initSchema,
  isReady,
  emptySlots,
  getOrCreateActiveWeek,
  getActiveWeek,
  getWeekById,
  claimMemberSlot,
  leaveMemberSlot,
  addOfficerSlot,
  removeOfficerSlot,
  setPanel,
  adoptPanelFrom,
  archiveWeek,
  listExpiredActiveWeeks,
  listActiveWeeks,
  close,
  // exported for tests / simulation
  _setCollectionForTests,
};
