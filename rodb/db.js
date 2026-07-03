// ---------------------------------------------------------------------------
// RoworldDB game-reference store — MongoDB Atlas via the native `mongodb` driver.
//
// READ-ONLY. This module never writes. It reads the rodb_* snapshot
// collections populated by scripts/import-roworlddb.js to power the
// /monster, /item, /card, and /map commands:
//
//   rodb_monsters  rodb_equipment  rodb_cards  rodb_maps  rodb_meta
//
// Own MongoClient — does NOT share the kudos/quiz/membersync/roster clients.
// Same Atlas cluster, same MONGODB_URI, separate MongoClient instance so a
// failure in one subsystem doesn't bleed into another (roster/db.js pattern).
//
// Graceful degradation: if MONGODB_URI is missing, Atlas is unreachable, or
// the import has never been run, the bot still boots fully. isReady() returns
// false; the commands reply with a "not available" message and autocomplete
// responds with an empty list instead of crashing. initSchema() never throws
// to the boot path. No index creation (indexes are created by the importer).
// ---------------------------------------------------------------------------

const { MongoClient } = require('mongodb');

const DB_NAME = 'discordbot';

const COLLECTIONS = {
  monsters: 'rodb_monsters',
  equipment: 'rodb_equipment',
  cards: 'rodb_cards',
  maps: 'rodb_maps',
  meta: 'rodb_meta',
};

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
  console.warn('[rodb/db] MONGODB_URI not set — game database commands disabled (bot still running).');
}

// Whether the store is usable. True only after a successful initSchema().
function isReady() {
  return connected && db !== null;
}

// ---------------------------------------------------------------------------
// Connect. Called once from ready.js boot. Returns true on success, false if
// disabled/unreachable (never throws). Strictly read-only — no index creation;
// scripts/import-roworlddb.js owns the collections and their indexes.
// ---------------------------------------------------------------------------
async function initSchema() {
  if (!client) return false; // no URI → disabled
  try {
    await client.connect();
    db = client.db(DB_NAME);
    connected = true;
    console.log('[rodb/db] Connected to MongoDB — game database ready (read-only).');
    return true;
  } catch (err) {
    connected = false;
    db = null;
    console.warn('[rodb/db] MongoDB connect failed — game database disabled:', err?.message || err);
    return false;
  }
}

async function init() {
  return initSchema();
}

// ---------------------------------------------------------------------------
// Name search — the autocomplete workhorse. Anchored prefix regex on the
// indexed nameLower field first; if that comes up short, tops up with a
// text-index whole-word search. Returns [] when not ready or on any error
// (autocomplete must never throw inside Discord's 3 s window).
// ---------------------------------------------------------------------------
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

async function searchByName(collName, query, limit = 25) {
  if (!isReady()) return [];
  const coll = db.collection(collName);
  const q = String(query || '').trim().toLowerCase();
  try {
    if (!q) {
      // Empty query → first alphabetical named entries (skips unnamed docs).
      return await coll.find({ nameLower: { $gt: '' } }).sort({ nameLower: 1 }).limit(limit).toArray();
    }
    const results = await coll
      .find({ nameLower: { $regex: `^${escapeRegex(q)}` } })
      .sort({ nameLower: 1 })
      .limit(limit)
      .toArray();
    if (results.length < limit) {
      try {
        const have = new Set(results.map((r) => r._id));
        const more = await coll.find({ $text: { $search: q } }).limit(limit).toArray();
        for (const m of more) {
          if (results.length >= limit) break;
          if (!have.has(m._id)) results.push(m);
        }
      } catch {
        // Text index missing (import not run with current script) — prefix
        // results alone are fine.
      }
    }
    return results;
  } catch (err) {
    console.warn(`[rodb/db] search failed on ${collName}:`, err?.message || err);
    return [];
  }
}

// Exact _id lookup. Autocomplete choice values are String(_id); ids are ints.
async function getById(collName, id) {
  if (!isReady()) return null;
  const n = Number(id);
  if (!Number.isFinite(n)) return null;
  try {
    return await db.collection(collName).findOne({ _id: n });
  } catch (err) {
    console.warn(`[rodb/db] getById failed on ${collName}:`, err?.message || err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Per-entity conveniences
// ---------------------------------------------------------------------------
const searchMonsters = (q, limit) => searchByName(COLLECTIONS.monsters, q, limit);
const searchEquipment = (q, limit) => searchByName(COLLECTIONS.equipment, q, limit);
const searchCards = (q, limit) => searchByName(COLLECTIONS.cards, q, limit);
const searchMaps = (q, limit) => searchByName(COLLECTIONS.maps, q, limit);

const getMonster = (id) => getById(COLLECTIONS.monsters, id);
const getEquipment = (id) => getById(COLLECTIONS.equipment, id);
const getCard = (id) => getById(COLLECTIONS.cards, id);
const getMap = (id) => getById(COLLECTIONS.maps, id);

// card → monsters that drop it. Precomputed at import time (doc.droppedBy);
// falls back to a live reverse query if the field is ever missing.
async function getCardSources(cardId) {
  const card = await getCard(cardId);
  if (!card) return [];
  if (Array.isArray(card.droppedBy)) return card.droppedBy;
  if (!isReady()) return [];
  try {
    const monsters = await db
      .collection(COLLECTIONS.monsters)
      .find({ 'drops.itemId': Number(cardId) })
      .limit(50)
      .toArray();
    return monsters.map((m) => ({
      monsterId: m._id,
      monsterName: m.name,
      level: m.level,
      type: m.type,
      ratePctUnbound: null,
      ratePctBound: null,
      guaranteedPityKills: null,
    }));
  } catch {
    return [];
  }
}

// monster → its drop list (embedded at import time).
async function getMonsterDrops(monsterId) {
  const monster = await getMonster(monsterId);
  return monster ? { drops: monster.drops || [], mvpDrops: monster.mvpDrops || [] } : null;
}

// Snapshot provenance doc ({assetVersion, importedAt, counts}) or null.
async function getMeta() {
  if (!isReady()) return null;
  try {
    return await db.collection(COLLECTIONS.meta).findOne({ _id: 'snapshot' });
  } catch {
    return null;
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
  init,
  initSchema,
  searchByName,
  getById,
  searchMonsters,
  searchEquipment,
  searchCards,
  searchMaps,
  getMonster,
  getEquipment,
  getCard,
  getMap,
  getCardSources,
  getMonsterDrops,
  getMeta,
  close,
  COLLECTIONS,
};
