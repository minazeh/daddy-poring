// ---------------------------------------------------------------------------
// Sticky message persistence — MongoDB Atlas via the native driver.
//
// Own MongoClient — does NOT share the kudos/quiz/membersync/roster/officerapp/
// rodb/activitycampaign/ticket/carry clients. Same Atlas cluster, same
// MONGODB_URI, separate MongoClient instance so a failure in one subsystem
// doesn't bleed into another. This is the house pattern (see ticket/db.js:47,
// activitycampaign/db.js:49).
//
// Graceful degradation (spec §6): if MONGODB_URI is missing or Atlas is
// unreachable the bot still boots fully. isReady() returns false;
// /stickymessage replies "unavailable" and the engine's onMessage skips
// reposting entirely — existing stickies simply stop following the
// conversation. Nothing crashes. initSchema() never throws to the boot path.
//
// THIS COLLECTION IS THE SOURCE OF TRUTH. The engine's watch Map is a cache,
// rebuilt from these documents by sticky/resume.js on every ready.
//
// Collection (db `discordbot`) — new + isolated to this feature:
//
//   sticky_messages — ONE DOC PER CHANNEL:
//     {
//       _id:        '<channelId>',   — the channel id IS the key, which is what
//                                      enforces "one sticky per channel" for
//                                      free (spec §7). No uniqueness check to
//                                      race, no second sticky possible.
//       guildId:    string,
//       content:    string,          — up to 4,000 chars, verbatim, NEVER cut
//       title:      string|null,     — presence of a title selects embed
//       color:      number|null,     — resolved int, or null for the default
//       messageId:  string|null,     — the live sticky message
//       setBy:      string,          — officer user id
//       setByName:  string,          — display name at set time
//       createdAt:  Date,
//       updatedAt:  Date,
//     }
// ---------------------------------------------------------------------------

const { MongoClient } = require('mongodb');

const DB_NAME = 'discordbot';
const STICKY_COLLECTION = 'sticky_messages';

let client = null;
let stickyCol = null;
let connected = false;

const uri = process.env.MONGODB_URI;

if (uri) {
  client = new MongoClient(uri, {
    serverSelectionTimeoutMS: 10_000,
    connectTimeoutMS: 10_000,
  });
} else {
  console.warn('[sticky/db] MONGODB_URI not set — sticky messages disabled (bot still running).');
}

// Whether the store is usable. True only after a successful initSchema()
// (or after a test injects fake collections).
function isReady() {
  return connected && stickyCol !== null;
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
    stickyCol = db.collection(STICKY_COLLECTION);

    // { guildId } backs /stickymessage list. _id (the channel id) is unique by
    // definition, so the per-channel lookup needs no index of its own.
    await stickyCol.createIndex({ guildId: 1 });

    connected = true;
    console.log('[sticky/db] Connected to MongoDB — sticky message store ready.');
    return true;
  } catch (err) {
    connected = false;
    stickyCol = null;
    console.warn('[sticky/db] MongoDB connect/index init failed — sticky messages disabled:', err?.message || err);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Reads.
// ---------------------------------------------------------------------------

// The sticky for one channel, or null.
async function get(channelId) {
  if (!isReady()) return null;
  return stickyCol.findOne({ _id: channelId });
}

// Every sticky in one guild, oldest first. Backs /stickymessage list.
async function listForGuild(guildId) {
  if (!isReady()) return [];
  return stickyCol.find({ guildId }).sort({ createdAt: 1 }).toArray();
}

// Every sticky, any guild. Backs the boot-time rebuild — the bot is
// single-guild today but resume() should not silently skip a second one.
async function listAll() {
  if (!isReady()) return [];
  return stickyCol.find({}).toArray();
}

// ---------------------------------------------------------------------------
// Writes.
// ---------------------------------------------------------------------------

// Create or replace the sticky for a channel. UPSERT on the channel id, so
// `set` in a channel that already has one REPLACES it (spec §3) with no
// read-then-write race — there is exactly one document either way.
//
// messageId is reset to null; the caller posts and calls setMessageId() next.
// createdAt is preserved across a replace via $setOnInsert.
async function upsert({ channelId, guildId, content, title, color, setBy, setByName }) {
  if (!isReady()) return null;
  const now = new Date();
  await stickyCol.updateOne(
    { _id: channelId },
    {
      $set: {
        guildId,
        content,
        title: title ?? null,
        color: color ?? null,
        messageId: null,
        setBy,
        setByName,
        updatedAt: now,
      },
      $setOnInsert: { createdAt: now },
    },
    { upsert: true },
  );
  return stickyCol.findOne({ _id: channelId });
}

// Record the live sticky message id — called after every repost so a restart
// can re-attach to the message that is actually on screen (spec §7).
async function setMessageId(channelId, messageId) {
  if (!isReady()) return false;
  const res = await stickyCol.updateOne(
    { _id: channelId },
    { $set: { messageId, updatedAt: new Date() } },
  );
  return res.matchedCount === 1;
}

// Drop the record for a channel. Called by /stickymessage remove and by the
// engine when the channel itself has been deleted (spec §6 — clean up rather
// than retry forever). Returns true if a document was actually removed.
//
// NOTE: this deletes a DATABASE ROW, which is what the feature is for. No file
// on disk is ever touched by this module.
async function remove(channelId) {
  if (!isReady()) return false;
  const res = await stickyCol.deleteOne({ _id: channelId });
  return res.deletedCount === 1;
}

// Optional clean shutdown.
async function close() {
  if (client) {
    try { await client.close(); } catch { /* ignore */ }
  }
  connected = false;
}

// Test hook — inject an in-memory fake collection so the whole feature can be
// exercised without touching Atlas. Never used at runtime. Same hook shape as
// partyfinder/db.js:162 and activitycampaign/db.js.
function _setCollectionsForTests(fakeStickyCol) {
  stickyCol = fakeStickyCol || null;
  connected = Boolean(fakeStickyCol);
}

module.exports = {
  isReady,
  initSchema,
  get,
  listForGuild,
  listAll,
  upsert,
  setMessageId,
  remove,
  close,
  // exported for tests / simulation
  _setCollectionsForTests,
};
