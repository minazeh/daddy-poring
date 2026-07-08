// ---------------------------------------------------------------------------
// Party Finder persistence (v2) — MongoDB Atlas via the native `mongodb` driver.
//
// v1 kept parties/carries in in-memory Maps only (state.js) — accepted tradeoff
// at the time: every card died on a Railway restart. v2 write-throughs every
// state mutation into two NEW isolated collections so open cards can be
// rehydrated on boot (resume.js) and their buttons keep working after a restart.
//
// Own MongoClient — does NOT share the kudos/quiz/membersync/roster/officerapp/
// rodb/activitycampaign/gvg/reactionrole clients. Same Atlas cluster, same
// MONGODB_URI, separate client instance so a failure in one subsystem doesn't
// bleed into another.
//
// Graceful degradation: if MONGODB_URI is missing or Atlas is unreachable, the
// bot boots fully and Party Finder behaves exactly like v1 — in-memory only,
// state lost on restart, nothing crashes. isReady() returns false, every helper
// below no-ops, and initSchema() never throws to the boot path. state.js calls
// the write helpers fire-and-forget with a .catch, so a mid-session Atlas
// hiccup can never fail a user interaction either.
//
// Collections (db `discordbot`) — NEW + isolated to this feature:
//
//   partyfinder_parties — ONE doc per OPEN party card (deleted on any close:
//   cancel / full / expiry):
//     { _id: '<partyId>', id, leaderId, leaderName, eventName, partySize,
//       roleCounts: {Tank,Heal,DPS}, slots: {Tank:[{userId,name}],...},
//       serverTime, startEpochSecs, expiryEpochSecs, powerRating,
//       messageId, channelId, closed, updatedAt }
//
//   partyfinder_carries — ONE doc per OPEN carry card (deleted on close):
//     { _id: '<requestId>', id, leaderId, leaderName, eventName, serverTime,
//       startEpochSecs, expiryEpochSecs, messageId, channelId,
//       responders: [{userId,name}], closed, updatedAt }
//
// _id is the in-memory counter id (stringified). That counter resets to 0 on
// restart, so resume.js restores it to the max persisted id across BOTH
// collections BEFORE any new card can be created — otherwise a fresh counter
// would mint ids that collide with restored docs. See the ID-collision note
// in resume.js.
// ---------------------------------------------------------------------------

const { MongoClient } = require('mongodb');

const DB_NAME = 'discordbot';
const PARTIES_COLLECTION = 'partyfinder_parties';
const CARRIES_COLLECTION = 'partyfinder_carries';

let client = null;
let partiesCol = null;
let carriesCol = null;
let connected = false;

const uri = process.env.MONGODB_URI;

if (uri) {
  client = new MongoClient(uri, {
    serverSelectionTimeoutMS: 10_000,
    connectTimeoutMS: 10_000,
  });
} else {
  console.warn('[partyfinder/db] MONGODB_URI not set — party/carry cards will not survive restarts (bot still running).');
}

// Whether the store is usable. True only after a successful initSchema().
function isReady() {
  return connected && partiesCol !== null && carriesCol !== null;
}

// ---------------------------------------------------------------------------
// Connect + idempotent index creation. Called once from ready.js boot.
// Returns true on success, false if disabled/unreachable (never throws).
// ---------------------------------------------------------------------------
async function initSchema() {
  if (!client) return false; // no URI → disabled
  try {
    await client.connect();
    const db = client.db(DB_NAME);
    partiesCol = db.collection(PARTIES_COLLECTION);
    carriesCol = db.collection(CARRIES_COLLECTION);
    // Runtime lookups are by _id — free. The channelId index materializes the
    // collections on first boot and supports any future per-channel admin
    // sweep. Idempotent.
    await partiesCol.createIndex({ channelId: 1 });
    await carriesCol.createIndex({ channelId: 1 });
    connected = true;
    console.log('[partyfinder/db] Connected to MongoDB — party-finder persistence ready.');
    return true;
  } catch (err) {
    connected = false;
    partiesCol = null;
    carriesCol = null;
    console.warn('[partyfinder/db] MongoDB connect/index init failed — persistence disabled (in-memory v1 behavior):', err?.message || err);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Write-through helpers. All no-op (return false) when the store isn't ready.
// Driver errors propagate to the caller — state.js fire-and-forgets with a
// .catch, resume.js runs inside its own try/catch.
// ---------------------------------------------------------------------------

// Upsert the FULL party object under _id = party.id (slots included) so the
// card can be fully rebuilt on resume. Idempotent.
async function upsertParty(party) {
  if (!isReady() || !party?.id) return false;
  await partiesCol.updateOne(
    { _id: party.id },
    { $set: { ...party, updatedAt: new Date() } },
    { upsert: true },
  );
  return true;
}

// Upsert the FULL carry-request object under _id = req.id (responders included).
async function upsertCarry(req) {
  if (!isReady() || !req?.id) return false;
  await carriesCol.updateOne(
    { _id: req.id },
    { $set: { ...req, updatedAt: new Date() } },
    { upsert: true },
  );
  return true;
}

// Closed cards are DELETED (not tombstoned) — the message itself is edited to
// the grey/green closed state and is never reopened, so keeping docs would
// only accumulate cruft.
async function deleteParty(partyId) {
  if (!isReady()) return false;
  await partiesCol.deleteOne({ _id: partyId });
  return true;
}

async function deleteCarry(requestId) {
  if (!isReady()) return false;
  await carriesCol.deleteOne({ _id: requestId });
  return true;
}

// Everything persisted, for boot-time rehydration. Only open docs should exist
// (closes delete), but resume.js still defensively skips doc.closed === true.
async function loadAll() {
  if (!isReady()) return { parties: [], carries: [] };
  const [parties, carries] = await Promise.all([
    partiesCol.find({}).toArray(),
    carriesCol.find({}).toArray(),
  ]);
  return { parties, carries };
}

// Optional clean shutdown.
async function close() {
  if (client) {
    try { await client.close(); } catch { /* ignore */ }
  }
  connected = false;
}

// Test hook — inject in-memory fake collections so write-through/resume logic
// can be exercised without touching Atlas. Never used at runtime.
function _setCollectionsForTests(fakePartiesCol, fakeCarriesCol) {
  partiesCol = fakePartiesCol || null;
  carriesCol = fakeCarriesCol || null;
  connected = Boolean(fakePartiesCol && fakeCarriesCol);
}

module.exports = {
  isReady,
  initSchema,
  upsertParty,
  upsertCarry,
  deleteParty,
  deleteCarry,
  loadAll,
  close,
  // exported for tests / simulation
  _setCollectionsForTests,
};
