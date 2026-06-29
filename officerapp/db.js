// ---------------------------------------------------------------------------
// Job-ad persistence — MongoDB Atlas via the native `mongodb` driver.
//
// Read+write. Backs the /jobad → officer-application feature so the applicant
// list + accept-count + poster survive bot restarts. The Apply button's
// customId already carries the ad message id, so after a restart the handler
// rehydrates the ad doc from this collection by _id (no in-memory state).
//
// Own MongoClient — does NOT share the kudos/quiz/membersync/roster clients.
// Same Atlas cluster, same MONGODB_URI, separate MongoClient instance so a
// failure in one subsystem doesn't bleed into another.
//
// Graceful degradation: if MONGODB_URI is missing or Atlas is unreachable, the
// bot still boots fully. isReady() returns false; the job-ad flow still posts +
// processes applications (customId-based) and just skips the persistent
// applicant-list update. initSchema() never throws to the boot path.
//
// Document shape (collection `discordbot.jobads`):
//   {
//     _id:         <adMessageId>  — the Discord message id of the ad (string)
//     channelId:   string
//     posterId:    string         — user id of the leadership poster
//     posterName:  string         — poster's server nickname at post time
//     title:       string
//     description: string
//     applicants:  [{ userId, name, ign, appliedAt: Date }]
//     status:      'open'          — ads stay open indefinitely (manual delete only)
//     createdAt:   Date
//     updatedAt:   Date
//   }
// ---------------------------------------------------------------------------

const { MongoClient } = require('mongodb');

const DB_NAME = 'discordbot';
const COLLECTION = 'jobads';

let client = null;
let collection = null;
let connected = false;

const uri = process.env.MONGODB_URI;

if (uri) {
  client = new MongoClient(uri, {
    serverSelectionTimeoutMS: 10_000,
    connectTimeoutMS: 10_000,
  });
} else {
  console.warn('[officerapp/db] MONGODB_URI not set — job-ad persistence disabled (bot still running).');
}

// Whether the job-ad store is usable. True only after a successful initSchema().
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
    // _id is the ad message id (unique by definition). Index status for
    // potential "list open ads" queries; idempotent.
    await collection.createIndex({ status: 1 });
    connected = true;
    console.log('[officerapp/db] Connected to MongoDB — job-ad store ready.');
    return true;
  } catch (err) {
    connected = false;
    collection = null;
    console.warn('[officerapp/db] MongoDB connect/index init failed — job-ad persistence disabled:', err?.message || err);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Create a job-ad doc. `doc` must include `_id` (the ad message id). Sets
// status/createdAt/updatedAt + empty applicants if not provided. Returns the
// stored doc, or null when not ready (caller degrades gracefully).
// ---------------------------------------------------------------------------
async function createJobAd(doc) {
  if (!isReady()) return null;
  const now = new Date();
  const full = {
    applicants: [],
    status: 'open',
    createdAt: now,
    ...doc,
    updatedAt: now,
  };
  // Upsert by _id so a re-post with the same id (shouldn't happen) is safe.
  await collection.replaceOne({ _id: full._id }, full, { upsert: true });
  return full;
}

// Fetch a job-ad doc by ad message id, or null.
async function getJobAd(adMessageId) {
  if (!isReady()) return null;
  return collection.findOne({ _id: adMessageId });
}

// ---------------------------------------------------------------------------
// Idempotently add an applicant (dedupe by userId). Pull-then-push so a
// re-application updates the entry rather than duplicating it. Returns the
// updated doc, or null when not ready.
// ---------------------------------------------------------------------------
async function addApplicant(adMessageId, applicant) {
  if (!isReady()) return null;
  const entry = {
    userId: applicant.userId,
    name: applicant.name,
    ign: applicant.ign,
    appliedAt: applicant.appliedAt instanceof Date ? applicant.appliedAt : new Date(),
  };
  // Remove any existing entry for this userId first (dedupe).
  await collection.updateOne(
    { _id: adMessageId },
    { $pull: { applicants: { userId: entry.userId } } },
  );
  // Then push the fresh entry + bump updatedAt.
  await collection.updateOne(
    { _id: adMessageId },
    { $push: { applicants: entry }, $set: { updatedAt: new Date() } },
  );
  return collection.findOne({ _id: adMessageId });
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
  createJobAd,
  getJobAd,
  addApplicant,
  close,
};
