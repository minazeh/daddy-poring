// ---------------------------------------------------------------------------
// Reaction-role persistence — MongoDB Atlas via the native `mongodb` driver.
//
// Backs /guildexpedition: every posted sign-up embed is registered here, and
// the messageReactionAdd/Remove handlers look reacted messages up here — no
// in-memory state — so reaction roles keep working across Railway restarts.
//
// Own MongoClient — does NOT share the kudos/quiz/membersync/roster/officerapp/
// rodb/activitycampaign/gvg clients. Same Atlas cluster, same MONGODB_URI,
// separate MongoClient instance so a failure in one subsystem doesn't bleed
// into another.
//
// Graceful degradation: if MONGODB_URI is missing or Atlas is unreachable, the
// bot still boots fully. isReady() returns false; /guildexpedition replies
// "unavailable" instead of posting, and the reaction handlers silently no-op.
// initSchema() never throws to the boot path.
//
// Collection (db `discordbot`) — NEW + isolated to this feature:
//
//   reactionrole_messages — ONE doc per posted sign-up embed:
//     {
//       _id:       string,   — the posted embed's Discord message id
//       channelId: string,   — channel the embed lives in
//       guildId:   string,
//       emoji:     string,   — unicode emoji (or custom-emoji id) to match
//       roleId:    string,   — role granted on react / removed on un-react
//       createdAt: Date,
//     }
// ---------------------------------------------------------------------------

const { MongoClient } = require('mongodb');

const DB_NAME = 'discordbot';
const MESSAGES_COLLECTION = 'reactionrole_messages';

let client = null;
let messagesCol = null;
let connected = false;

const uri = process.env.MONGODB_URI;

if (uri) {
  client = new MongoClient(uri, {
    serverSelectionTimeoutMS: 10_000,
    connectTimeoutMS: 10_000,
  });
} else {
  console.warn('[reactionrole/db] MONGODB_URI not set — reaction roles disabled (bot still running).');
}

// Whether the store is usable. True only after a successful initSchema().
function isReady() {
  return connected && messagesCol !== null;
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
    messagesCol = db.collection(MESSAGES_COLLECTION);
    // Lookups are by _id (message id) — free. guildId+channelId supports any
    // future "list active sign-up embeds" admin view. Idempotent.
    await messagesCol.createIndex({ guildId: 1, channelId: 1 });
    connected = true;
    console.log('[reactionrole/db] Connected to MongoDB — reaction-role store ready.');
    return true;
  } catch (err) {
    connected = false;
    messagesCol = null;
    console.warn('[reactionrole/db] MongoDB connect/index init failed — reaction roles disabled:', err?.message || err);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Message registrations.
// ---------------------------------------------------------------------------

// Register a posted sign-up embed so the reaction handlers can find it after
// any restart. Upsert on message id (idempotent). Returns true on success,
// false when not ready.
async function registerMessage({ messageId, channelId, guildId, emoji, roleId }) {
  if (!isReady()) return false;
  await messagesCol.updateOne(
    { _id: messageId },
    {
      $set: { channelId, guildId, emoji, roleId },
      $setOnInsert: { createdAt: new Date() },
    },
    { upsert: true },
  );
  return true;
}

// The registration doc for a message id, or null (not registered / not ready).
async function getMessage(messageId) {
  if (!isReady()) return null;
  return messagesCol.findOne({ _id: messageId });
}

// Optional clean shutdown.
async function close() {
  if (client) {
    try { await client.close(); } catch { /* ignore */ }
  }
  connected = false;
}

// Test hook — inject an in-memory fake collection so the register/lookup logic
// can be exercised without touching Atlas. Never used at runtime.
function _setCollectionForTests(fakeMessagesCol) {
  messagesCol = fakeMessagesCol;
  connected = Boolean(fakeMessagesCol);
}

module.exports = {
  isReady,
  initSchema,
  registerMessage,
  getMessage,
  close,
  // exported for tests / simulation
  _setCollectionForTests,
};
