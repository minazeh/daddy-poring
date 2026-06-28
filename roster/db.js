// ---------------------------------------------------------------------------
// Guild-roster persistence — MongoDB Atlas via the native `mongodb` driver.
//
// READ-ONLY. This module never writes. It reads the web-owned `parties`,
// `raidGroups`, and `settings` collections plus the membersync-owned `members`
// collection to render the /guildroster command.
//
// Own MongoClient — does NOT share the kudos/quiz/membersync clients. Same
// Atlas cluster, same MONGODB_URI, separate MongoClient instance so a failure
// in one subsystem doesn't bleed into another.
//
// Graceful degradation: if MONGODB_URI is missing or Atlas is unreachable, the
// bot still boots fully. isReady() returns false; /guildroster replies with a
// "not available" message instead of crashing. initSchema() never throws to the
// boot path. No index creation (read-only).
//
// Collections (db `discordbot`):
//   members    — { userId, username, displayName, avatarUrl, isMain, isSub,
//                  className, classRoleId, updatedAt }
//                Daddy guild ⇔ isMain===true; Mummy guild ⇔ isSub===true.
//   parties    — { partyId:"${type}-${field}-${position}", type:"daddy"|"mummy",
//                  field:"main"|"sub", name, memberIds:string[], position,
//                  lockedSlots:number[], updatedAt }
//   raidGroups — { raidGroupId, type, field, name, partyIds:string[], position,
//                  updatedAt }
//   settings   — single global doc { _id:"global", requiredClasses, classRoles,
//                  partySize, mainPartyCount, subPartyCount, updatedAt }
// ---------------------------------------------------------------------------

const { MongoClient } = require('mongodb');

const DB_NAME = 'discordbot';

let client = null;
let db = null;
let connected = false;

const uri = process.env.MONGODB_URI;

if (uri) {
  client = new MongoClient(uri, {
    serverSelectionTimeoutMS: 10_000,
    connectTimeoutMS: 10_000,
  });
} else {
  console.warn('[roster/db] MONGODB_URI not set — guild roster disabled (bot still running).');
}

// Whether the roster store is usable. True only after a successful initSchema().
function isReady() {
  return connected && db !== null;
}

// ---------------------------------------------------------------------------
// Connect. Called once from ready.js boot. Returns true on success, false if
// disabled/unreachable (never throws). No index creation — this module is
// strictly read-only, and the collections are owned by membersync / the web app.
// ---------------------------------------------------------------------------
async function initSchema() {
  if (!client) return false; // no URI → disabled
  try {
    await client.connect();
    db = client.db(DB_NAME);
    connected = true;
    console.log('[roster/db] Connected to MongoDB — guild roster ready (read-only).');
    return true;
  } catch (err) {
    connected = false;
    db = null;
    console.warn('[roster/db] MongoDB connect failed — guild roster disabled:', err?.message || err);
    return false;
  }
}

// init() alias — mirrors the membersync/kudos init naming so callers can use
// either. ready.js calls initSchema() directly to match the existing pattern.
async function init() {
  return initSchema();
}

// guild → the field predicate on the members collection.
//   'daddy' → isMain === true ; 'mummy' → isSub === true
function membersFilterForGuild(guild) {
  return guild === 'mummy' ? { isSub: true } : { isMain: true };
}

// ---------------------------------------------------------------------------
// Read functions — all return [] / null when not ready (never throw to caller's
// happy path; the command wraps calls in try/catch regardless).
// ---------------------------------------------------------------------------

// Members for a guild: daddy ⇔ isMain, mummy ⇔ isSub.
async function getMembers(guild) {
  if (!isReady()) return [];
  return db.collection('members').find(membersFilterForGuild(guild)).toArray();
}

// Parties where type === guild.
async function getParties(guild) {
  if (!isReady()) return [];
  return db.collection('parties').find({ type: guild }).toArray();
}

// Raid groups where type === guild, sorted by position ascending.
async function getRaidGroups(guild) {
  if (!isReady()) return [];
  return db.collection('raidGroups').find({ type: guild }).sort({ position: 1 }).toArray();
}

// The single global settings doc, or null if none.
async function getSettings() {
  if (!isReady()) return null;
  return db.collection('settings').findOne({ _id: 'global' });
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
  init,
  initSchema,
  getMembers,
  getParties,
  getRaidGroups,
  getSettings,
  close,
};
