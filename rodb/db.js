// ---------------------------------------------------------------------------
// RoworldDB game-reference store — MongoDB Atlas via the native `mongodb` driver.
//
// READ-ONLY. This module never writes. It reads the rodb_* snapshot
// collections populated by scripts/import-roworlddb.js to power the
// /monster, /item, /card, /map, /skill, /rune, /refine, /pet, and /shop
// commands:
//
//   rodb_monsters  rodb_equipment  rodb_cards  rodb_maps  rodb_meta
//   rodb_skills    rodb_runes      rodb_refine rodb_pets  rodb_shop
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
  skills: 'rodb_skills',
  runes: 'rodb_runes',
  refine: 'rodb_refine',
  pets: 'rodb_pets',
  shop: 'rodb_shop',
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

async function searchByName(collName, query, limit = 25, extraFilter = null) {
  if (!isReady()) return [];
  const coll = db.collection(collName);
  const q = String(query || '').trim().toLowerCase();
  const withExtra = (filter) => (extraFilter ? { ...filter, ...extraFilter } : filter);
  try {
    if (!q) {
      // Empty query → first alphabetical named entries (skips unnamed docs).
      return await coll.find(withExtra({ nameLower: { $gt: '' } })).sort({ nameLower: 1 }).limit(limit).toArray();
    }
    const results = await coll
      .find(withExtra({ nameLower: { $regex: `^${escapeRegex(q)}` } }))
      .sort({ nameLower: 1 })
      .limit(limit)
      .toArray();
    if (results.length < limit) {
      try {
        const have = new Set(results.map((r) => r._id));
        const more = await coll.find(withExtra({ $text: { $search: q } })).limit(limit).toArray();
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
// Optional jobName narrows skill search to one class (Tier B class filter).
const searchSkills = (q, limit, jobName) =>
  searchByName(COLLECTIONS.skills, q, limit, jobName ? { jobsLower: String(jobName).toLowerCase() } : null);
const searchRunes = (q, limit) => searchByName(COLLECTIONS.runes, q, limit);
const searchPets = (q, limit) => searchByName(COLLECTIONS.pets, q, limit);
const searchShop = (q, limit) => searchByName(COLLECTIONS.shop, q, limit);

const getMonster = (id) => getById(COLLECTIONS.monsters, id);
const getEquipment = (id) => getById(COLLECTIONS.equipment, id);
const getCard = (id) => getById(COLLECTIONS.cards, id);
const getMap = (id) => getById(COLLECTIONS.maps, id);
const getSkill = (id) => getById(COLLECTIONS.skills, id);
const getRune = (id) => getById(COLLECTIONS.runes, id);
const getPet = (id) => getById(COLLECTIONS.pets, id);
const getShopListing = (id) => getById(COLLECTIONS.shop, id);

// ---------------------------------------------------------------------------
// Tier A/B extras
// ---------------------------------------------------------------------------

// All job/class names present in the skill snapshot — for the /skill class
// option's autocomplete. Cached (snapshot data never changes at runtime).
let skillJobsCache = null;
async function getSkillJobs() {
  if (!isReady()) return [];
  if (skillJobsCache) return skillJobsCache;
  try {
    const jobs = await db.collection(COLLECTIONS.skills).distinct('jobs');
    skillJobsCache = jobs.filter(Boolean).sort((a, b) => a.localeCompare(b));
    return skillJobsCache;
  } catch (err) {
    console.warn('[rodb/db] getSkillJobs failed:', err?.message || err);
    return [];
  }
}

// Shop listings selling a given item id (Tier B "Sold at" on /item).
async function getShopListingsByItemId(itemId) {
  if (!isReady()) return [];
  const n = Number(itemId);
  if (!Number.isFinite(n)) return [];
  try {
    return await db.collection(COLLECTIONS.shop).find({ itemId: n }).limit(10).toArray();
  } catch (err) {
    console.warn('[rodb/db] getShopListingsByItemId failed:', err?.message || err);
    return [];
  }
}

// Refine odds: one level (int) or the whole 20-row table, plus the global
// config doc (safe levels, pity bonuses, tier groups) from rodb_meta.
async function getRefineLevel(level) {
  return getById(COLLECTIONS.refine, level);
}

async function getRefineTable() {
  if (!isReady()) return [];
  try {
    return await db.collection(COLLECTIONS.refine).find({}).sort({ _id: 1 }).toArray();
  } catch (err) {
    console.warn('[rodb/db] getRefineTable failed:', err?.message || err);
    return [];
  }
}

async function getRefineConfig() {
  if (!isReady()) return null;
  try {
    return await db.collection(COLLECTIONS.meta).findOne({ _id: 'refine_config' });
  } catch {
    return null;
  }
}

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

// ---------------------------------------------------------------------------
// Random sample — read-only $sample aggregate. Used by the Monster Quiz to draw
// question candidates. Returns [] when not ready or on any error (graceful
// degrade — never throws). `n` is clamped to a sane positive integer.
// ---------------------------------------------------------------------------
async function sampleDocs(collName, n, filter = null) {
  if (!isReady()) return [];
  const size = Math.max(1, Math.floor(Number(n) || 1));
  try {
    const pipeline = [];
    if (filter) pipeline.push({ $match: filter });
    pipeline.push({ $sample: { size } });
    return await db.collection(collName).aggregate(pipeline).toArray();
  } catch (err) {
    console.warn(`[rodb/db] sampleDocs failed on ${collName}:`, err?.message || err);
    return [];
  }
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
  sampleDocs,
  searchMonsters,
  searchEquipment,
  searchCards,
  searchMaps,
  searchSkills,
  searchRunes,
  searchPets,
  searchShop,
  getMonster,
  getEquipment,
  getCard,
  getMap,
  getSkill,
  getRune,
  getPet,
  getShopListing,
  getSkillJobs,
  getShopListingsByItemId,
  getRefineLevel,
  getRefineTable,
  getRefineConfig,
  getCardSources,
  getMonsterDrops,
  getMeta,
  close,
  COLLECTIONS,
};
