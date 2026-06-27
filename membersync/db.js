// ---------------------------------------------------------------------------
// Member-sync persistence — MongoDB Atlas via the native `mongodb` driver.
//
// Own MongoClient — does NOT share the kudos/quiz client. Same Atlas cluster,
// same MONGODB_URI, separate MongoClient instance so kudos failures don't
// bleed into member-sync and vice-versa.
//
// Graceful degradation: if MONGODB_URI is missing or Atlas is unreachable, the
// bot still boots fully. isReady() returns false; /syncmembers replies with a
// "not configured" message instead of crashing. initSchema() never throws to
// the boot path.
//
// Document schema (collection `discordbot.members`):
//   {
//     userId:      string  — Discord user snowflake (unique index key)
//     username:    string  — Discord username (e.g. "someone")
//     displayName: string  — Server nickname (falls back to username)
//     avatarUrl:   string|null  — guild avatar URL (size=256); null if none
//     isMain:      boolean — true  → holds the Daddy (ACCEPTED) role
//     isSub:       boolean — true  → holds the Mummy role
//     className:   string|null  — resolved via CLASS_ROLE_BY_ID; null if no class role
//     classRoleId: string|null  — the matching class role ID; null if none
//     updatedAt:   Date    — last time this doc was upserted
//   }
//
// A member may be both isMain and isSub simultaneously (edge case: holds both
// roles). The sync keeps whatever Discord says — no opinion on that.
// ---------------------------------------------------------------------------

const { MongoClient } = require('mongodb');

const DB_NAME    = 'discordbot';
const COLLECTION = 'members';

let client     = null;
let collection = null;
let connected  = false;

const uri = process.env.MONGODB_URI;

if (uri) {
  client = new MongoClient(uri, {
    serverSelectionTimeoutMS: 10_000,
    connectTimeoutMS:         10_000,
  });
} else {
  console.warn('[membersync/db] MONGODB_URI not set — member sync disabled (bot still running).');
}

// Whether the member-sync store is usable. True only after a successful
// initSchema() call. Surfaces degrade gracefully until then.
function isReady() {
  return connected && collection !== null;
}

// ---------------------------------------------------------------------------
// Connect + idempotent index creation. Called once from ready.js boot.
// Returns true on success, false if disabled/unreachable (never throws).
// ---------------------------------------------------------------------------
async function initSchema() {
  if (!client) return false; // no URI → disabled
  try {
    await client.connect();
    collection = client.db(DB_NAME).collection(COLLECTION);

    // Unique index on userId — the upsert filter key.
    await collection.createIndex({ userId: 1 }, { unique: true });

    // Support roster queries filtered by affiliation.
    await collection.createIndex({ isMain: 1 });
    await collection.createIndex({ isSub: 1 });

    // Composite: useful for "who is main+DPS?" style queries from the web app.
    await collection.createIndex({ isMain: 1, className: 1 });
    await collection.createIndex({ isSub: 1,  className: 1 });

    connected = true;
    console.log('[membersync/db] Connected to MongoDB — members collection ready.');
    return true;
  } catch (err) {
    connected  = false;
    collection = null;
    console.warn('[membersync/db] MongoDB connect/index init failed — member sync disabled:', err?.message || err);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Bulk-upsert an array of member docs. Each doc must contain at minimum:
//   { userId, username, displayName, avatarUrl, isMain, isSub,
//     className, classRoleId, updatedAt }
// Uses unordered bulkWrite for throughput; partial failures log but don't throw.
// ---------------------------------------------------------------------------
async function upsertMembers(docs) {
  if (!isReady() || !docs.length) return;
  const ops = docs.map(doc => ({
    updateOne: {
      filter: { userId: doc.userId },
      update: { $set: doc },
      upsert:  true,
    },
  }));
  await collection.bulkWrite(ops, { ordered: false });
}

// ---------------------------------------------------------------------------
// Delete docs whose userId is NOT in the provided currentUserIds set.
// Keeps the stored roster accurate after members leave or lose both roles.
// ---------------------------------------------------------------------------
async function removeStale(currentUserIds) {
  if (!isReady()) return;
  // If the current roster is empty something is very wrong — skip deletion
  // rather than nuking the entire collection.
  if (!currentUserIds.length) {
    console.warn('[membersync/db] removeStale called with empty set — skipping to avoid full wipe.');
    return;
  }
  const result = await collection.deleteMany({ userId: { $nin: currentUserIds } });
  if (result.deletedCount > 0) {
    console.log(`[membersync/db] Removed ${result.deletedCount} stale member doc(s).`);
  }
}

// Optional clean shutdown.
async function close() {
  if (client) {
    try { await client.close(); } catch { /* ignore */ }
  }
  connected = false;
}

module.exports = {
  isReady,
  initSchema,
  upsertMembers,
  removeStale,
  close,
};
