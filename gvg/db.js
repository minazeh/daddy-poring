// ---------------------------------------------------------------------------
// GvG attendance persistence — MongoDB Atlas via the native `mongodb` driver.
//
// Read+write. Backs /gvgschedule, /gvgvc, and the attendance window capture so
// schedules, monitored VCs, and in-progress/completed attendance all survive
// bot restarts.
//
// Own MongoClient — does NOT share the kudos/quiz/membersync/roster/officerapp/
// rodb/activitycampaign clients. Same Atlas cluster, same MONGODB_URI,
// separate MongoClient instance so a failure in one subsystem doesn't bleed
// into another.
//
// Graceful degradation: if MONGODB_URI is missing or Atlas is unreachable, the
// bot still boots fully. isReady() returns false; /gvgschedule and /gvgvc
// reply "unavailable", no timers are armed, and the voiceStateUpdate handler
// no-ops. initSchema() never throws to the boot path.
//
// Collections (db `discordbot`) — ALL new + isolated to this feature:
//
//   gvg_schedules — one doc per weekly-recurring GvG time:
//     {
//       _id:         ObjectId,
//       day:         'Monday'…'Sunday',
//       time:        'HH:MM'  (24 h, GMT+7 — see gvg/constants.js),
//       guild:       'daddy' | 'mummy' | 'both',   — which VCs to check
//       durationMin: number,                        — capture window length
//       label:       string | null,                 — optional friendly name
//       guildId:     string,                        — Discord guild it was added in
//       createdBy:   string,                        — userId of the Godfather
//       createdAt:   Date,
//     }
//
//   gvg_voicechannels — one doc per monitored voice channel:
//     {
//       _id:       ObjectId,
//       channelId: string,            — Discord voice-channel id (unique)
//       label:     string,            — e.g. 'Daddy Main'
//       guild:     'daddy' | 'mummy', — roster guild this VC belongs to
//       guildId:   string,
//       addedBy:   string,
//       createdAt: Date,
//     }
//
//   gvg_attendance — one doc per fired capture window. Written in_progress at
//   window start, updated live as members join (restart-resume reads it back),
//   finalized at window end. Web-app-ready: the completed doc carries the full
//   per-VC result with roster flags.
//     {
//       _id:        ObjectId,
//       status:     'in_progress' | 'completed',
//       schedule:   { id, day, time, guild, durationMin, label },  — snapshot
//       guildId:    string,
//       startedAt:  Date,
//       endsAt:     Date,
//       vcs:        [{ channelId, label, guild }],   — VCs selected for this run
//       expected:   { daddy?: [{ userId, displayName }],   — roster snapshot at
//                     mummy?: [{ userId, displayName }] }    session START; a
//                     guild key only if it's in the schedule's target. {} when
//                     the roster was unavailable at start (web app treats a
//                     missing/empty expected as "no roster data" → excluded
//                     from attendance-rate denominators).
//       members:    { <channelId>: { <userId>: {
//                       userId, username, displayName,
//                       firstSeenAt: Date, lastSeenAt: Date } } },
//       — set on completion —
//       completedAt:     Date,
//       rosterAvailable: boolean,     — false ⇒ label-only log (no flags)
//       result: [{ channelId, label, guild, count, flaggedCount,
//                  members: [{ userId, username, displayName, firstSeenAt,
//                              lastSeenAt, onRoster, flagged }] }],
//       postedMessageIds: string[],        — every attendance-log message
//                                            (the log paginates across
//                                            multiple embeds/messages for
//                                            large guilds)
//       postedMessageId:  string | null,   — first id (back-compat)
//     }
// ---------------------------------------------------------------------------

const { MongoClient, ObjectId } = require('mongodb');

const DB_NAME = 'discordbot';
const SCHEDULES_COLLECTION = 'gvg_schedules';
const VCS_COLLECTION = 'gvg_voicechannels';
const ATTENDANCE_COLLECTION = 'gvg_attendance';

let client = null;
let schedulesCol = null;
let vcsCol = null;
let attendanceCol = null;
let connected = false;

const uri = process.env.MONGODB_URI;

if (uri) {
  client = new MongoClient(uri, {
    serverSelectionTimeoutMS: 10_000,
    connectTimeoutMS: 10_000,
  });
} else {
  console.warn('[gvg/db] MONGODB_URI not set — GvG attendance disabled (bot still running).');
}

// Whether the store is usable. True only after a successful initSchema().
function isReady() {
  return connected && schedulesCol !== null && vcsCol !== null && attendanceCol !== null;
}

// Parse a string id into an ObjectId, or null when malformed (bad autocomplete
// value, stale pick, etc.) — callers treat null as "not found".
function toObjectId(id) {
  try {
    return new ObjectId(String(id));
  } catch {
    return null;
  }
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
    schedulesCol = db.collection(SCHEDULES_COLLECTION);
    vcsCol = db.collection(VCS_COLLECTION);
    attendanceCol = db.collection(ATTENDANCE_COLLECTION);
    // channelId is the natural key for monitored VCs (one registration per
    // channel). status powers the restart-resume scan; startedAt the web-app
    // history views. All idempotent.
    await vcsCol.createIndex({ channelId: 1 }, { unique: true });
    await attendanceCol.createIndex({ status: 1 });
    await attendanceCol.createIndex({ startedAt: -1 });
    connected = true;
    console.log('[gvg/db] Connected to MongoDB — GvG attendance store ready.');
    return true;
  } catch (err) {
    connected = false;
    schedulesCol = null;
    vcsCol = null;
    attendanceCol = null;
    console.warn('[gvg/db] MongoDB connect/index init failed — GvG attendance disabled:', err?.message || err);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Schedules.
// ---------------------------------------------------------------------------

// Insert a weekly-recurring schedule. Returns the inserted doc, or null.
async function addSchedule({ day, time, guild, durationMin, label, guildId, createdBy }) {
  if (!isReady()) return null;
  const doc = {
    day,
    time,
    guild,
    durationMin,
    label: label || null,
    guildId,
    createdBy,
    createdAt: new Date(),
  };
  const res = await schedulesCol.insertOne(doc);
  return { _id: res.insertedId, ...doc };
}

// All schedules, oldest-first. Returns [] when not ready.
async function getSchedules() {
  if (!isReady()) return [];
  return schedulesCol.find({}).sort({ createdAt: 1 }).toArray();
}

// One schedule by id string, or null.
async function getSchedule(id) {
  if (!isReady()) return null;
  const oid = toObjectId(id);
  if (!oid) return null;
  return schedulesCol.findOne({ _id: oid });
}

// Remove a schedule by id string. Returns the removed doc, or null when not
// found / not ready (so the command can name what it removed).
async function removeSchedule(id) {
  if (!isReady()) return null;
  const oid = toObjectId(id);
  if (!oid) return null;
  const doc = await schedulesCol.findOne({ _id: oid });
  if (!doc) return null;
  await schedulesCol.deleteOne({ _id: oid });
  return doc;
}

// ---------------------------------------------------------------------------
// Monitored voice channels.
// ---------------------------------------------------------------------------

// Register a monitored VC. Upserts on channelId so re-adding the same channel
// updates its label/guild instead of erroring on the unique index. Returns the
// doc, or null when not ready.
async function addVoiceChannel({ channelId, label, guild, guildId, addedBy }) {
  if (!isReady()) return null;
  const now = new Date();
  await vcsCol.updateOne(
    { channelId },
    {
      $set: { label, guild, guildId, addedBy },
      $setOnInsert: { createdAt: now },
    },
    { upsert: true },
  );
  return vcsCol.findOne({ channelId });
}

// All monitored VCs, oldest-first. Returns [] when not ready.
async function getVoiceChannels() {
  if (!isReady()) return [];
  return vcsCol.find({}).sort({ createdAt: 1 }).toArray();
}

// Monitored VCs for a schedule's guild target: 'both' → all, otherwise only
// VCs tagged with that guild. Returns [] when not ready.
async function getVoiceChannelsForTarget(target) {
  if (!isReady()) return [];
  const filter = target === 'both' ? {} : { guild: target };
  return vcsCol.find(filter).sort({ createdAt: 1 }).toArray();
}

// Remove a monitored VC by id string. Returns the removed doc, or null.
async function removeVoiceChannel(id) {
  if (!isReady()) return null;
  const oid = toObjectId(id);
  if (!oid) return null;
  const doc = await vcsCol.findOne({ _id: oid });
  if (!doc) return null;
  await vcsCol.deleteOne({ _id: oid });
  return doc;
}

// ---------------------------------------------------------------------------
// Attendance captures.
// ---------------------------------------------------------------------------

// Create the in_progress capture doc at window start (with the start
// snapshot's members already filled in). Returns the id string, or null.
async function createCapture({ schedule, guildId, startedAt, endsAt, vcs, members, expected }) {
  if (!isReady()) return null;
  const res = await attendanceCol.insertOne({
    status: 'in_progress',
    schedule,
    guildId,
    startedAt,
    endsAt,
    vcs,
    members: members || {},
    // Roster snapshot at session start — who was EXPECTED. Persisted here so it
    // survives a restart and is present on the completed doc (completeCapture
    // never overwrites it). {} when the roster was unavailable at start.
    expected: expected || {},
  });
  return String(res.insertedId);
}

// Record one member under one VC in an in-progress capture ($set on a dot
// path, so mid-window joins are persisted immediately — restart-safe).
// memberRec = { userId, username, displayName, firstSeenAt, lastSeenAt }.
async function setCaptureMember(captureId, channelId, memberRec) {
  if (!isReady()) return false;
  const oid = toObjectId(captureId);
  if (!oid) return false;
  await attendanceCol.updateOne(
    { _id: oid },
    { $set: { [`members.${channelId}.${memberRec.userId}`]: memberRec } },
  );
  return true;
}

// Update just the lastSeenAt of an already-recorded member (on VC leave).
async function setCaptureMemberLastSeen(captureId, channelId, userId, lastSeenAt) {
  if (!isReady()) return false;
  const oid = toObjectId(captureId);
  if (!oid) return false;
  await attendanceCol.updateOne(
    { _id: oid },
    { $set: { [`members.${channelId}.${userId}.lastSeenAt`]: lastSeenAt } },
  );
  return true;
}

// All in-progress captures (restart-resume scan on ready). Returns [].
async function getInProgressCaptures() {
  if (!isReady()) return [];
  return attendanceCol.find({ status: 'in_progress' }).toArray();
}

// Finalize a capture: status completed + the compiled per-VC result (roster
// flags included) + EVERY posted log message id. The paginated log can span
// several messages, so postedMessageIds is an array; postedMessageId keeps the
// first id for backward-compatible single-id readers. Returns true on success.
async function completeCapture(captureId, { rosterAvailable, result, postedMessageIds }) {
  if (!isReady()) return false;
  const oid = toObjectId(captureId);
  if (!oid) return false;
  const ids = Array.isArray(postedMessageIds) ? postedMessageIds : [];
  await attendanceCol.updateOne(
    { _id: oid },
    {
      $set: {
        status: 'completed',
        completedAt: new Date(),
        rosterAvailable,
        result,
        postedMessageIds: ids,
        postedMessageId: ids[0] || null,
      },
    },
  );
  return true;
}

// Optional clean shutdown.
async function close() {
  if (client) {
    try { await client.close(); } catch { /* ignore */ }
  }
  connected = false;
}

// Test hook — inject in-memory fake collections so schedule/VC/capture logic
// can be exercised without touching Atlas. Never used at runtime.
function _setCollectionsForTests(fakeSchedulesCol, fakeVcsCol, fakeAttendanceCol) {
  schedulesCol = fakeSchedulesCol;
  vcsCol = fakeVcsCol;
  attendanceCol = fakeAttendanceCol;
  connected = Boolean(fakeSchedulesCol && fakeVcsCol && fakeAttendanceCol);
}

module.exports = {
  isReady,
  initSchema,
  // schedules
  addSchedule,
  getSchedules,
  getSchedule,
  removeSchedule,
  // voice channels
  addVoiceChannel,
  getVoiceChannels,
  getVoiceChannelsForTarget,
  removeVoiceChannel,
  // attendance captures
  createCapture,
  setCaptureMember,
  setCaptureMemberLastSeen,
  getInProgressCaptures,
  completeCapture,
  close,
  // exported for tests / simulation
  _setCollectionsForTests,
};
