// ---------------------------------------------------------------------------
// Kudos persistence — MongoDB Atlas via the native `mongodb` driver.
//
// One SRV URI (MONGODB_URI) works from both Conrad's laptop and Railway. Atlas
// negotiates TLS automatically over mongodb+srv, so there's no manual SSL config.
//
// Graceful degradation: if MONGODB_URI is missing or the initial connect fails,
// the bot still boots fully (Party Finder etc. unaffected). isReady() returns
// false and the kudos surfaces show a "not configured" message instead.
//
// Document shape (collection `discordbot.kudos`):
//   { guildId, giverId, recipientId, reason: string|null, createdAt: Date }
// ---------------------------------------------------------------------------

const { MongoClient } = require('mongodb');

const DB_NAME = 'discordbot';
const COLLECTION = 'kudos';
const DAILY_LIMIT = 7;

let client = null;
let collection = null;
let connected = false;

const uri = process.env.MONGODB_URI;

if (uri) {
  // Build the client eagerly; connect lazily/async (initSchema triggers the
  // connect on boot). The client is reused for the process lifetime.
  client = new MongoClient(uri, {
    serverSelectionTimeoutMS: 10000,
    connectTimeoutMS: 10000,
  });
} else {
  console.warn('[kudos/db] MONGODB_URI not set — kudos system disabled (bot still running).');
}

// Whether the kudos store is connected and usable. True only after a successful
// connect (in initSchema). Until then, surfaces degrade gracefully.
function isReady() {
  return connected && collection !== null;
}

// ---------------------------------------------------------------------------
// Connect + idempotent index creation. Called once after login from ready.js.
// Returns true on success, false if disabled/unreachable (never throws to the
// boot path — caller logs, bot keeps running).
// ---------------------------------------------------------------------------
async function initSchema() {
  if (!client) return false; // no URI -> disabled
  try {
    await client.connect();
    collection = client.db(DB_NAME).collection(COLLECTION);
    // Idempotent — createIndex is a no-op if the index already exists.
    await collection.createIndex({ recipientId: 1 });
    await collection.createIndex({ giverId: 1, createdAt: 1 });
    await collection.createIndex({ guildId: 1 });
    connected = true;
    return true;
  } catch (err) {
    connected = false;
    collection = null;
    console.warn('[kudos/db] MongoDB connect/index init failed — kudos disabled:', err?.message || err);
    return false;
  }
}

// Optional clean shutdown (handy for tests / future signal handling).
async function close() {
  if (client) {
    try { await client.close(); } catch { /* ignore */ }
  }
  connected = false;
}

// ---------------------------------------------------------------------------
// GMT+7 day-start as a UTC instant. The "current day" boundary is midnight in
// GMT+7. Shift now into GMT+7, zero the wall-clock time, shift back to UTC.
// Returns a Date (UTC instant of the GMT+7 midnight that starts the current day).
// ---------------------------------------------------------------------------
const GMT7_OFFSET_MS = 7 * 60 * 60 * 1000;

function gmt7DayStart(nowMs = Date.now()) {
  const shifted = new Date(nowMs + GMT7_OFFSET_MS); // wall-clock in GMT+7 (read via UTC getters)
  const y = shifted.getUTCFullYear();
  const m = shifted.getUTCMonth();
  const d = shifted.getUTCDate();
  const midnightGmt7AsUtcMs = Date.UTC(y, m, d, 0, 0, 0, 0) - GMT7_OFFSET_MS;
  return new Date(midnightGmt7AsUtcMs);
}

// ---------------------------------------------------------------------------
// Data access. Public API preserved 1:1 with the previous (pg) version so
// messageCreate.js / kudosboard.js / profile.js need NO changes:
//   isReady, DAILY_LIMIT, countGivenToday, award, topRecipients, rankForRecipient
// (topRecipients still returns rows shaped { recipient_id, total }).
// ---------------------------------------------------------------------------

// Low-level: how many kudos a giver handed out since `sinceDate`.
async function givenCountSince(giverId, sinceDate) {
  return collection.countDocuments({ giverId, createdAt: { $gte: sinceDate } });
}

// How many kudos the giver has handed out since GMT+7 midnight today.
async function countGivenToday(giverId, nowMs = Date.now()) {
  return givenCountSince(giverId, gmt7DayStart(nowMs));
}

// Insert one kudo doc. reason may be null.
async function addKudos(guildId, giverId, recipientId, reason) {
  await collection.insertOne({
    guildId,
    giverId,
    recipientId,
    reason: reason ?? null,
    createdAt: new Date(),
  });
}

// Public award() — name/signature preserved (used by messageCreate.js).
async function award(guildId, giverId, recipientId, reason) {
  return addKudos(guildId, giverId, recipientId, reason);
}

// Top N recipients for a guild. Returns rows shaped { recipient_id, total }
// (snake_case key kept so the commands need no change), total DESC.
async function topRecipients(guildId, limit = 15) {
  const rows = await collection.aggregate([
    { $match: { guildId } },
    { $group: { _id: '$recipientId', total: { $sum: 1 } } },
    { $sort: { total: -1, _id: 1 } },
    { $limit: limit },
  ]).toArray();
  return rows.map(r => ({ recipient_id: r._id, total: r.total }));
}

// Total kudos a recipient has received in a guild.
async function totalForRecipient(guildId, recipientId) {
  return collection.countDocuments({ guildId, recipientId });
}

// Rank of a recipient = (# recipients with strictly more kudos) + 1. Also
// returns the total number of distinct recipients in the guild.
async function rankForRecipient(guildId, recipientId) {
  const myTotal = await totalForRecipient(guildId, recipientId);

  const distinct = await collection.distinct('recipientId', { guildId });
  const totalRecipients = distinct.length;

  if (myTotal === 0) {
    return { total: 0, rank: null, totalRecipients };
  }

  // Count recipients whose total is strictly greater than mine.
  const aheadRows = await collection.aggregate([
    { $match: { guildId } },
    { $group: { _id: '$recipientId', total: { $sum: 1 } } },
    { $match: { total: { $gt: myTotal } } },
    { $count: 'ahead' },
  ]).toArray();
  const ahead = aheadRows.length ? aheadRows[0].ahead : 0;

  return { total: myTotal, rank: ahead + 1, totalRecipients };
}

module.exports = {
  isReady,
  initSchema,
  close,
  // GMT+7 helper (exported for tests)
  gmt7DayStart,
  // data access (public API consumed by messageCreate/kudosboard/profile)
  countGivenToday,
  givenCountSince,
  award,
  addKudos,
  topRecipients,
  totalForRecipient,
  rankForRecipient,
  DAILY_LIMIT,
};
