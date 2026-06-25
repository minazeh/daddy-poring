// ---------------------------------------------------------------------------
// Class Quiz persistence — MongoDB Atlas via the native `mongodb` driver.
//
// Reuses the SAME Atlas cluster as Kudos (one MONGODB_URI, db `discordbot`).
// Built to mirror kudos/db.js: eager client build, lazy connect in initSchema(),
// isReady() gate, graceful degradation (no URI / unreachable -> quiz disabled,
// bot still boots). initSchema() never throws to the boot path.
//
// Collections (db `discordbot`):
//   quiz_scores         { userId(unique), username, points, correctCount, wrongCount }
//   quiz_active         { channelId(unique), channelKey, messageId, question,
//                         options:{A,B,C,D}, correctAnswer, postedAt:Date,
//                         answeredUsers:[], correctUsers:[] }
//   quiz_leaderboard_msg{ guildId(unique), channelId, messageId }
// ---------------------------------------------------------------------------

const { MongoClient } = require('mongodb');

const DB_NAME = 'discordbot';
const C_SCORES = 'quiz_scores';
const C_ACTIVE = 'quiz_active';
const C_LBMSG = 'quiz_leaderboard_msg';

let client = null;
let scores = null;
let active = null;
let lbmsg = null;
let connected = false;

const uri = process.env.MONGODB_URI;

if (uri) {
  client = new MongoClient(uri, {
    serverSelectionTimeoutMS: 10000,
    connectTimeoutMS: 10000,
  });
} else {
  console.warn('[quiz/db] MONGODB_URI not set — quiz system disabled (bot still running).');
}

function isReady() {
  return connected && scores !== null && active !== null && lbmsg !== null;
}

// Connect + idempotent index creation. Called once after login from ready.js.
// Returns true on success, false if disabled/unreachable. Never throws to boot.
async function initSchema() {
  if (!client) return false;
  try {
    await client.connect();
    const db = client.db(DB_NAME);
    scores = db.collection(C_SCORES);
    active = db.collection(C_ACTIVE);
    lbmsg = db.collection(C_LBMSG);
    // Idempotent — createIndex is a no-op if already present.
    await scores.createIndex({ userId: 1 }, { unique: true });
    await scores.createIndex({ points: -1 });
    await active.createIndex({ channelId: 1 }, { unique: true });
    await lbmsg.createIndex({ guildId: 1 }, { unique: true });
    connected = true;
    return true;
  } catch (err) {
    connected = false;
    scores = active = lbmsg = null;
    console.warn('[quiz/db] MongoDB connect/index init failed — quiz disabled:', err?.message || err);
    return false;
  }
}

async function close() {
  if (client) {
    try { await client.close(); } catch { /* ignore */ }
  }
  connected = false;
}

// ---------------------------------------------------------------------------
// Scores
// ---------------------------------------------------------------------------

// Mirror of the source add_point: +1 point on correct, bump correct/wrong tallies.
async function addPoint(userId, username, correct) {
  await scores.updateOne(
    { userId },
    {
      $set: { username },
      $inc: {
        points: correct ? 1 : 0,
        correctCount: correct ? 1 : 0,
        wrongCount: correct ? 0 : 1,
      },
      $setOnInsert: { userId },
    },
    { upsert: true },
  );
}

// Top N scorers, points DESC (userId asc tiebreak for stable ordering).
async function getLeaderboard(limit = 15) {
  return scores
    .find({}, { projection: { _id: 0, username: 1, points: 1, correctCount: 1, wrongCount: 1 } })
    .sort({ points: -1, userId: 1 })
    .limit(limit)
    .toArray();
}

// ---------------------------------------------------------------------------
// Active questions
// ---------------------------------------------------------------------------

// Open a new active question for a channel (replaces any prior one — fresh
// answered/correct lists). Mirrors set_active_question.
async function setActiveQuestion(channelId, channelKey, messageId, question, options, correctAnswer, postedAt) {
  await active.replaceOne(
    { channelId },
    {
      channelId,
      channelKey,
      messageId,
      question,
      options,
      correctAnswer,
      postedAt, // Date
      answeredUsers: [],
      correctUsers: [],
    },
    { upsert: true },
  );
}

async function getActiveQuestion(channelId) {
  return active.findOne({ channelId });
}

// All open questions (for recover-on-boot).
async function getAllActiveQuestions() {
  return active.find({}).toArray();
}

// Record that a user answered (idempotent via $addToSet). Returns nothing.
async function recordAnswer(channelId, userId) {
  await active.updateOne({ channelId }, { $addToSet: { answeredUsers: userId } });
}

async function hasAnswered(channelId, userId) {
  const doc = await active.findOne(
    { channelId, answeredUsers: userId },
    { projection: { _id: 1 } },
  );
  return doc !== null;
}

// Append a display name to the public "got it right" list.
async function recordCorrectAnswer(channelId, displayName) {
  await active.updateOne({ channelId }, { $push: { correctUsers: displayName } });
}

async function getCorrectUsers(channelId) {
  const doc = await active.findOne({ channelId }, { projection: { correctUsers: 1 } });
  return doc ? (doc.correctUsers || []) : [];
}

async function clearActiveQuestion(channelId) {
  await active.deleteOne({ channelId });
}

// ---------------------------------------------------------------------------
// Leaderboard message pointer
// ---------------------------------------------------------------------------

async function getLeaderboardMessage(guildId) {
  return lbmsg.findOne({ guildId });
}

async function setLeaderboardMessage(guildId, channelId, messageId) {
  await lbmsg.replaceOne(
    { guildId },
    { guildId, channelId, messageId },
    { upsert: true },
  );
}

module.exports = {
  isReady,
  initSchema,
  close,
  // scores
  addPoint,
  getLeaderboard,
  // active questions
  setActiveQuestion,
  getActiveQuestion,
  getAllActiveQuestions,
  recordAnswer,
  hasAnswered,
  recordCorrectAnswer,
  getCorrectUsers,
  clearActiveQuestion,
  // leaderboard message
  getLeaderboardMessage,
  setLeaderboardMessage,
};
