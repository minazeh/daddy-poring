// ---------------------------------------------------------------------------
// Activity-campaign persistence — MongoDB Atlas via the native `mongodb` driver.
//
// Read+write. Backs the /activitycampaign launch pulse-check so the sticky
// prompt location + everyone's weekly answers survive bot restarts.
//
// Own MongoClient — does NOT share the kudos/quiz/membersync/roster/officerapp/
// rodb clients. Same Atlas cluster, same MONGODB_URI, separate MongoClient
// instance so a failure in one subsystem doesn't bleed into another.
//
// Graceful degradation: if MONGODB_URI is missing or Atlas is unreachable, the
// bot still boots fully. isReady() returns false; /activitycampaign replies
// "unavailable", button clicks get an ephemeral "couldn't record", and the
// sticky repost is skipped. initSchema() never throws to the boot path.
//
// Collections (db `discordbot`) — BOTH new + isolated to this feature:
//
//   activitycampaign_config — single doc, _id 'campaign' (one active campaign
//   at a time):
//     {
//       _id:             'campaign',
//       active:          boolean,
//       guildId:         string|null,
//       channelId:       string|null,   — channel the sticky lives in
//       stickyMessageId: string|null,   — current sticky prompt message id
//       promptText:      string|null,   — the message body typed at /start
//                                          (persists so reposts + restart-
//                                          resume reuse Conrad's actual text,
//                                          and prefills the next /start modal)
//       startedAt:       Date|null,
//       updatedAt:       Date,
//     }
//
//   activitycampaign_responses — ONE doc per (userId, weekKey); the button
//   handler UPSERTS so a member's latest answer within a week wins, and a new
//   ISO week (UTC) starts a fresh doc:
//     {
//       _id:         '<userId>:<weekKey>',
//       userId:      string,
//       username:    string,        — account username at click time
//       displayName: string,        — server display name at click time
//       answer:      'yes' | 'no',
//       weekKey:     string,        — e.g. '2026-W29' (ISO week, UTC)
//       guildId:     string,
//       createdAt:   Date,          — first answer that week
//       updatedAt:   Date,          — latest change that week
//     }
// ---------------------------------------------------------------------------

const { MongoClient } = require('mongodb');

const DB_NAME = 'discordbot';
const CONFIG_COLLECTION = 'activitycampaign_config';
const RESPONSES_COLLECTION = 'activitycampaign_responses';
const CONFIG_ID = 'campaign';

let client = null;
let configCol = null;
let responsesCol = null;
let connected = false;

const uri = process.env.MONGODB_URI;

if (uri) {
  client = new MongoClient(uri, {
    serverSelectionTimeoutMS: 10_000,
    connectTimeoutMS: 10_000,
  });
} else {
  console.warn('[activitycampaign/db] MONGODB_URI not set — activity campaign disabled (bot still running).');
}

// Whether the store is usable. True only after a successful initSchema().
function isReady() {
  return connected && configCol !== null && responsesCol !== null;
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
    configCol = db.collection(CONFIG_COLLECTION);
    responsesCol = db.collection(RESPONSES_COLLECTION);
    // weekKey powers the /status weekly tally; answer speeds the all-time
    // group. _id ('<userId>:<weekKey>') is unique by definition. Idempotent.
    await responsesCol.createIndex({ weekKey: 1 });
    await responsesCol.createIndex({ weekKey: 1, answer: 1 });
    connected = true;
    console.log('[activitycampaign/db] Connected to MongoDB — activity-campaign store ready.');
    return true;
  } catch (err) {
    connected = false;
    configCol = null;
    responsesCol = null;
    console.warn('[activitycampaign/db] MongoDB connect/index init failed — activity campaign disabled:', err?.message || err);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Config (single active campaign).
// ---------------------------------------------------------------------------

// The campaign config doc, or null (no doc yet / not ready).
async function getConfig() {
  if (!isReady()) return null;
  return configCol.findOne({ _id: CONFIG_ID });
}

// Activate the campaign in a channel with the given prompt text (also used to
// MOVE it and/or change the text — caller deletes the old sticky first).
// Resets stickyMessageId; the caller sets it right after posting the prompt.
// promptText persists across a later deactivate so the next /start modal can
// prefill it. Returns the fresh config, or null when not ready.
async function activate(guildId, channelId, promptText) {
  if (!isReady()) return null;
  const now = new Date();
  await configCol.updateOne(
    { _id: CONFIG_ID },
    {
      $set: {
        active: true,
        guildId,
        channelId,
        promptText,
        stickyMessageId: null,
        startedAt: now,
        updatedAt: now,
      },
    },
    { upsert: true },
  );
  return configCol.findOne({ _id: CONFIG_ID });
}

// Deactivate the campaign. Keeps channel history fields harmless; clears the
// sticky pointer. Returns true on success, false when not ready.
async function deactivate() {
  if (!isReady()) return false;
  await configCol.updateOne(
    { _id: CONFIG_ID },
    { $set: { active: false, stickyMessageId: null, updatedAt: new Date() } },
    { upsert: true },
  );
  return true;
}

// Record the current sticky prompt message id (called on every repost).
async function setStickyMessageId(messageId) {
  if (!isReady()) return false;
  await configCol.updateOne(
    { _id: CONFIG_ID },
    { $set: { stickyMessageId: messageId, updatedAt: new Date() } },
    { upsert: true },
  );
  return true;
}

// ---------------------------------------------------------------------------
// Responses (one per user per ISO week; latest answer wins within the week).
// ---------------------------------------------------------------------------

// Upsert a member's answer for the week. Same user + same week → the existing
// doc is updated in place (answer/displayName/updatedAt), so re-clicks and
// changed minds never create duplicates; a new week means a new _id → a new
// doc. Returns true on success, false when not ready.
async function recordResponse({ userId, username, displayName, answer, weekKey, guildId }) {
  if (!isReady()) return false;
  const now = new Date();
  await responsesCol.updateOne(
    { _id: `${userId}:${weekKey}` },
    {
      $set: { userId, username, displayName, answer, weekKey, guildId, updatedAt: now },
      $setOnInsert: { createdAt: now },
    },
    { upsert: true },
  );
  return true;
}

// All responses for one week, oldest-first. Returns [] when not ready.
async function getWeekResponses(weekKey) {
  if (!isReady()) return [];
  return responsesCol.find({ weekKey }).sort({ createdAt: 1 }).toArray();
}

// All-time totals across every week:
//   { yes, no, uniqueResponders }  (yes/no = weekly answer docs per side)
// Returns null when not ready.
async function getAllTimeTotals() {
  if (!isReady()) return null;
  const groups = await responsesCol.aggregate([
    { $group: { _id: '$answer', count: { $sum: 1 } } },
  ]).toArray();
  const totals = { yes: 0, no: 0, uniqueResponders: 0 };
  for (const g of groups) {
    if (g._id === 'yes') totals.yes = g.count;
    if (g._id === 'no') totals.no = g.count;
  }
  const users = await responsesCol.distinct('userId');
  totals.uniqueResponders = users.length;
  return totals;
}

// Optional clean shutdown.
async function close() {
  if (client) {
    try { await client.close(); } catch { /* ignore */ }
  }
  connected = false;
}

// Test hook — inject in-memory fake collections so the upsert/tally logic can
// be exercised without touching Atlas. Never used at runtime.
function _setCollectionsForTests(fakeConfigCol, fakeResponsesCol) {
  configCol = fakeConfigCol;
  responsesCol = fakeResponsesCol;
  connected = Boolean(fakeConfigCol && fakeResponsesCol);
}

module.exports = {
  isReady,
  initSchema,
  getConfig,
  activate,
  deactivate,
  setStickyMessageId,
  recordResponse,
  getWeekResponses,
  getAllTimeTotals,
  close,
  // exported for tests / simulation
  _setCollectionsForTests,
};
