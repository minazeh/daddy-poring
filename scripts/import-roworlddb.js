#!/usr/bin/env node
// ---------------------------------------------------------------------------
// One-time RoworldDB snapshot importer.
//
//   node scripts/import-roworlddb.js
//
// Downloads the seven static en-US JSON datasets that power roworlddb.com's
// monster-album / equipment / card / map pages (they are plain unauthenticated
// files — see docs/ROWORLDDB_RECON.md), saves the RAW files to
// data/roworlddb-snapshot/ first (audit trail; re-runs never re-fetch a file
// that is already on disk and parseable), transforms them, and UPSERTS into
// five NEW MongoDB collections:
//
//   rodb_monsters   (~2,673)   rodb_equipment (~2,664)
//   rodb_cards      (~226)     rodb_maps      (~354)
//   rodb_meta       (1 doc — snapshot version + import timestamp + counts)
//
// SAFETY:
//   * Writes ONLY to collections prefixed `rodb_` — a hard assert guards every
//     collection handle. Existing bot data (members / parties / kudos / …) is
//     never read, written, or dropped.
//   * Idempotent: replaceOne upserts keyed by _id; createIndex is idempotent.
//     Nothing is ever dropped. Re-running refreshes the same docs in place.
//   * Polite to roworlddb.com: fetches only files missing from the snapshot
//     dir, >= 2 s apart, one retry with backoff, honest User-Agent.
//
// Transformations (per docs/ROWORLDDB_RECON.md):
//   * Drop rates: raw `r`/`f` integers are percent x 1e6 (site JS:
//     SITE_RATE_SCALE = 1e6). Stored as ratePct numbers.
//   * Equipment: stats/conditions/stunts/affixes/jobs/types are ID-coded and
//     resolved to display strings via the lookup dicts in the same file.
//     Attribute values with percentage_show are /100 (e.g. [23,500] = Max HP% +5%).
//   * Cards: reverse "dropped by" join built from monster drop_rate_entries
//     (kind card_variant, bound/unbound) + guaranteed_card pity.
//   * Maps: index merged with the (sparse — 36/354) spawn views; region name
//     resolved from world_maps via center_scene_id / pic_res.
//   * Images: hotlinked roworlddb.com URLs resolved via icon_paths.json
//     (7,597 icon -> subpath entries) with a prefix heuristic fallback.
// ---------------------------------------------------------------------------

'use strict';

const fs = require('node:fs');
const path = require('node:path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { MongoClient } = require('mongodb');

const BASE = 'https://roworlddb.com';
const IMAGE_BASE = `${BASE}/media/images/`;
const SNAPSHOT_DIR = path.join(__dirname, '..', 'data', 'roworlddb-snapshot');
const SNAPSHOT_INFO = path.join(SNAPSHOT_DIR, 'snapshot-info.json');
const DB_NAME = 'discordbot';
const USER_AGENT = 'daddy-poring-snapshot/1.0 (one-time guild Discord bot import; low volume)';
const FETCH_DELAY_MS = 2500;

// Site rate scale: r / 1e6 = percent (verified in monster_album.js: SITE_RATE_SCALE = 1e6).
const RATE_SCALE = 1e6;

const FILES = [
  { name: 'monster_album_en-US.json',      url: `${BASE}/sea/monster-album/data/monster_album_en-US.json` },
  { name: 'handbook_cards_en-US.json',     url: `${BASE}/sea/card-simulator/data/handbook_cards_en-US.json` },
  { name: 'equipment_en-US.json',          url: `${BASE}/sea/equipment/data/equipment_en-US.json` },
  { name: 'map_index_en-US.json',          url: `${BASE}/sea/map-simulator/data/map_index_en-US.json` },
  { name: 'map_monster_spawns_en-US.json', url: `${BASE}/sea/map-simulator/data/map_monster_spawns_en-US.json` },
  { name: 'map_subregions_en-US.json',     url: `${BASE}/sea/map-simulator/data/map_subregions_en-US.json` },
  { name: 'icon_paths.json',               url: `${BASE}/sea/skill-simulator/data/icon_paths.json` },
];

// The ONLY collections this script may touch. coll() asserts against this list.
const ALLOWED_COLLECTIONS = new Set([
  'rodb_monsters', 'rodb_equipment', 'rodb_cards', 'rodb_maps', 'rodb_meta',
]);

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

// ---------------------------------------------------------------------------
// Snapshot acquisition — reuse on-disk raw files; fetch only what's missing.
// ---------------------------------------------------------------------------

function readJsonIfValid(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

async function fetchWithRetry(url) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (err) {
      if (attempt === 2) throw err;
      console.warn(`  retrying ${url} in 5s (${err.message})`);
      await sleep(5000);
    }
  }
  throw new Error('unreachable');
}

async function ensureSnapshot() {
  fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });
  const data = {};
  let fetchedAny = false;

  for (const { name, url } of FILES) {
    const file = path.join(SNAPSHOT_DIR, name);
    let json = fs.existsSync(file) ? readJsonIfValid(file) : null;
    if (json) {
      console.log(`[snapshot] reusing on-disk ${name}`);
    } else {
      if (fetchedAny) await sleep(FETCH_DELAY_MS); // stay >=2s apart
      console.log(`[snapshot] fetching ${url}`);
      const text = await fetchWithRetry(url);
      json = JSON.parse(text); // validate BEFORE saving
      fs.writeFileSync(file, text);
      fetchedAny = true;
    }
    data[name] = json;
  }

  // Provenance: reuse recorded info; otherwise pull the asset-version meta tag
  // from the monster-album shell page (one extra polite GET) or mark unknown.
  let info = readJsonIfValid(SNAPSHOT_INFO);
  if (!info) {
    let assetVersion = 'unknown';
    try {
      await sleep(FETCH_DELAY_MS);
      const html = await fetchWithRetry(`${BASE}/sea/monster-album/`);
      const m = html.match(/<meta\s+name="asset-version"\s+content="([^"]+)"/i);
      if (m) assetVersion = m[1];
    } catch (err) {
      console.warn('[snapshot] could not read asset-version:', err.message);
    }
    info = {
      assetVersion,
      locale: 'en-US',
      source: `${BASE}/sea/`,
      fetchedAt: new Date().toISOString(),
    };
    fs.writeFileSync(SNAPSHOT_INFO, JSON.stringify(info, null, 2));
  }

  return { data, info };
}

// ---------------------------------------------------------------------------
// Image URL resolution via icon_paths.json, with prefix-heuristic fallback.
// ---------------------------------------------------------------------------

function makeIconResolver(iconPaths) {
  let unresolved = 0;
  const resolve = (icon, fallbackDir) => {
    if (!icon) return null;
    const sub = iconPaths[icon];
    if (sub) return IMAGE_BASE + String(sub).replace(/\\/g, '/');
    unresolved += 1;
    // icon_monster_head_x -> monster/, icon_item_x -> item/, icon_map_x -> map/ ...
    const m = /^icon_([a-z]+)_/.exec(icon);
    const dir = m ? m[1] : (fallbackDir || 'item');
    return `${IMAGE_BASE}${dir}/${icon}.webp`;
  };
  resolve.unresolvedCount = () => unresolved;
  return resolve;
}

// ---------------------------------------------------------------------------
// Transforms
// ---------------------------------------------------------------------------

const ratePct = (r) => (typeof r === 'number' && Number.isFinite(r) ? r / RATE_SCALE : null);
const lower = (s) => (typeof s === 'string' ? s.trim().toLowerCase() : '');

// Merge a monster's drops[] display list with its drop_rate_entries[] rates.
// Returns [{itemId, name, quality, isCard, ratePct, boundRatePct, qualityRates}]
function buildDrops(displayDrops, rateEntries) {
  const entries = Array.isArray(rateEntries) ? rateEntries : [];
  const byItem = new Map();
  for (const e of entries) {
    if (!byItem.has(e.item_id)) byItem.set(e.item_id, []);
    byItem.get(e.item_id).push(e);
  }

  const seen = new Set();
  const out = [];

  const pushItem = (itemId, name, quality, isCard) => {
    if (seen.has(itemId)) return;
    seen.add(itemId);
    const rates = byItem.get(itemId) || [];
    const drop = { itemId, name, quality: quality ?? null, isCard: !!isCard, ratePct: null, boundRatePct: null };
    const qualityRates = [];
    for (const e of rates) {
      if (e.kind === 'card_variant') {
        if (e.variant === 'bound') drop.boundRatePct = ratePct(e.r);
        else drop.ratePct = ratePct(e.r); // unbound
        drop.isCard = true;
      } else if (e.kind === 'equipment_quality') {
        const p = ratePct(e.r);
        if (p !== null) qualityRates.push({ quality: e.quality ?? null, ratePct: p });
      } else {
        const p = ratePct(e.r);
        if (p !== null && drop.ratePct === null) drop.ratePct = p;
      }
    }
    if (qualityRates.length) drop.qualityRates = qualityRates;
    out.push(drop);
  };

  for (const d of Array.isArray(displayDrops) ? displayDrops : []) {
    pushItem(d.item_id, d.name, d.quality, d.is_card);
  }
  // Rate entries for items missing from drops[] (defensive; usually none).
  for (const e of entries) {
    if (!seen.has(e.item_id)) pushItem(e.item_id, e.name, e.quality, e.kind === 'card_variant');
  }
  return out;
}

function transformMonsters(album, icon) {
  return (album.monsters || []).map((m) => ({
    _id: m.id,
    name: m.name ?? null,
    nameLower: lower(m.name),
    level: m.level ?? null,
    type: m.type?.name ?? null,
    race: m.race?.name ?? null,
    element: m.element?.name ?? null,
    size: m.body?.name ?? null,
    stats: m.stats ?? {},
    isHandbook: !!m.is_handbook,
    imageUrl: icon(m.image, 'monster'),
    drops: buildDrops(m.drops, m.drop_rate_entries),
    mvpDrops: buildDrops(null, m.mvp_drop_rate_entries),
    guaranteedCard: m.guaranteed_card
      ? {
          itemId: m.guaranteed_card.item_id,
          name: m.guaranteed_card.name,
          pityKills: m.guaranteed_card_drop_progress ?? null,
        }
      : null,
    activities: Array.isArray(m.activities) ? m.activities : [],
  }));
}

// Placeholder texts the equipment dicts contain ("t", "2", "Stunt 100205", "Job 101").
const isPlaceholderText = (t) =>
  !t || t.length < 3 || /^stunt \d+$/i.test(t) || /^\d+$/.test(t);
const isPlaceholderJob = (n) => !n || /^job \d+$/i.test(n);

function transformEquipment(eq, icon) {
  const attrs = eq.attributes || {};
  const jobs = eq.jobs || {};
  const conditions = eq.conditions || {};
  const stunts = eq.stunts || {};
  const affixes = eq.affixes || {};
  const buffs = eq.buffs || {};
  const itemTypes = eq.itemTypes || {};
  const itemSubtypes = eq.itemSubtypes || {};
  const suitById = new Map(Object.values(eq.suits || {}).map((s) => [s.id, s]));

  const resolveStat = (pair) => {
    if (!Array.isArray(pair) || pair.length < 2) return null;
    const [attrId, raw] = pair;
    const a = attrs[String(attrId)];
    const isPercent = !!a?.percentage_show;
    return {
      name: a?.name || `Attr ${attrId}`,
      value: isPercent ? raw / 100 : raw,
      isPercent,
    };
  };

  return (eq.items || []).map((it) => {
    const typeEntry = itemTypes[String(it.itemType)];
    const isShadow = it.itemType >= 201 && it.itemType <= 206;
    const typeName = typeEntry ? `${isShadow ? 'Shadow ' : ''}${typeEntry.name}` : null;

    const jobNames = (it.jobLimits || [])
      .map((id) => jobs[String(id)]?.name)
      .filter((n) => n && !isPlaceholderJob(n));

    const effects = [
      ...(it.conditions || []).map((id) => conditions[String(id)]?.text),
      ...(it.stunts || []).map((id) => stunts[String(id)]?.text),
      ...(it.buffs || []).map((id) => buffs[String(id)]?.desc),
    ].filter((t) => t && !isPlaceholderText(t));

    const affixTexts = (it.fixedAffixes || [])
      .map((id) => affixes[String(id)]?.text)
      .filter((t) => t && !isPlaceholderText(t));

    const suitId = Array.isArray(it.suits) && it.suits.length ? it.suits[0] : null;
    const suitDef = suitId !== null ? suitById.get(suitId) : null;

    return {
      _id: it.id,
      name: it.name ?? null,
      nameLower: lower(it.name),
      quality: it.quality ?? null,
      level: it.openLevel ?? null,
      typeName,
      subtypeName: itemSubtypes[String(it.itemSubtype)]?.name ?? null,
      isHandbook: !!it.isHandBook,
      jobAll: !!it.jobAll,
      jobs: it.jobAll ? 'All' : jobNames,
      jobCount: it.jobAll ? null : (it.jobLimits || []).length,
      stats: (it.stats || []).map(resolveStat).filter(Boolean),
      refineStats: (it.refinePerLevel || []).map(resolveStat).filter(Boolean),
      effects,
      affixes: affixTexts,
      suit: suitDef
        ? {
            name: (suitDef.name || '').trim() || null,
            effects: (suitDef.effects || []).map((e) => ({ num: e.num, desc: e.desc })),
          }
        : null,
      imageUrl: icon(it.icon, 'item'),
    };
  });
}

// Reverse join: cardId -> [{monsterId, monsterName, level, ratePctUnbound, ratePctBound, guaranteedPityKills}]
function buildCardSources(album) {
  const sources = new Map();
  const entryFor = (cardId, m) => {
    if (!sources.has(cardId)) sources.set(cardId, new Map());
    const perMonster = sources.get(cardId);
    if (!perMonster.has(m.id)) {
      perMonster.set(m.id, {
        monsterId: m.id,
        monsterName: m.name ?? null,
        level: m.level ?? null,
        type: m.type?.name ?? null,
        ratePctUnbound: null,
        ratePctBound: null,
        guaranteedPityKills: null,
      });
    }
    return perMonster.get(m.id);
  };

  for (const m of album.monsters || []) {
    for (const e of m.drop_rate_entries || []) {
      if (e.kind !== 'card_variant') continue;
      const src = entryFor(e.item_id, m);
      if (e.variant === 'bound') src.ratePctBound = ratePct(e.r);
      else src.ratePctUnbound = ratePct(e.r);
    }
    for (const d of m.drops || []) {
      if (d.is_card) entryFor(d.item_id, m); // ensure listed even without rate rows
    }
    if (m.guaranteed_card?.item_id) {
      const src = entryFor(m.guaranteed_card.item_id, m);
      src.guaranteedPityKills = m.guaranteed_card_drop_progress ?? null;
    }
  }

  const out = new Map();
  for (const [cardId, perMonster] of sources) {
    out.set(
      cardId,
      [...perMonster.values()].sort((a, b) => (a.level ?? 0) - (b.level ?? 0)),
    );
  }
  return out;
}

function transformCards(cardsFile, album, icon) {
  const droppedByMap = buildCardSources(album);
  return (cardsFile.cards || []).map((c) => ({
    _id: c.id,
    name: c.name ?? null,
    nameLower: lower(c.name),
    quality: c.quality ?? null,
    slot: c.card_type_name ?? null,
    effectLines:
      Array.isArray(c.effect_lines) && c.effect_lines.length
        ? c.effect_lines
        : [c.effect, c.effect_extra].filter(Boolean),
    effectExtra: c.effect_extra || null,
    hasMvpSource: !!c.has_mvp_source,
    droppedBy: droppedByMap.get(c.id) || [],
    imageUrl: icon(c.item_icon, 'item'),
  }));
}

function transformMaps(mapIndex, spawnsFile, icon) {
  const worldMaps = mapIndex.world_maps || [];
  const byCenter = new Map(worldMaps.map((w) => [w.center_scene_id, w.name]));
  const byPic = new Map(worldMaps.map((w) => [w.pic_res, w.name]));
  const views = spawnsFile.views || {};

  return Object.values(mapIndex.map_configs || {}).map((cfg) => {
    const view = views[String(cfg.map_id)];
    const spawns = (view?.monsters || []).map((s) => ({
      monsterId: s.monster_id,
      name: s.name ?? null,
      family: s.family ?? null, // mvp | mini | elite | normal ...
      spawnSpots: s.total_spawn_spots ?? null,
      collectedSpots: s.collected_spawn_spots ?? null,
    }));
    return {
      _id: cfg.map_id,
      name: cfg.name ?? null,
      nameLower: lower(cfg.name),
      region: byCenter.get(cfg.map_id) || byPic.get(cfg.pic_res) || null,
      isWorldHub: byCenter.has(cfg.map_id),
      imageUrl: icon(cfg.pic_res, 'map'),
      spawns,
    };
  });
}

// ---------------------------------------------------------------------------
// Load
// ---------------------------------------------------------------------------

async function upsertAll(db, collName, docs) {
  if (!ALLOWED_COLLECTIONS.has(collName)) {
    throw new Error(`refusing to touch non-rodb collection: ${collName}`);
  }
  const coll = db.collection(collName);
  const CHUNK = 500;
  let upserted = 0;
  let modified = 0;
  for (let i = 0; i < docs.length; i += CHUNK) {
    const ops = docs.slice(i, i + CHUNK).map((doc) => ({
      replaceOne: { filter: { _id: doc._id }, replacement: doc, upsert: true },
    }));
    const res = await coll.bulkWrite(ops, { ordered: false });
    upserted += res.upsertedCount;
    modified += res.modifiedCount;
  }
  await coll.createIndex({ nameLower: 1 });
  await coll.createIndex({ name: 'text' });
  const total = await coll.countDocuments();
  console.log(`[load] ${collName}: ${docs.length} docs (${upserted} new, ${modified} updated) — collection now ${total}`);
  return total;
}

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error('MONGODB_URI is not set (fill in .env). Aborting before any download.');
    process.exit(1);
  }

  console.log('=== RoworldDB import ===');
  const { data, info } = await ensureSnapshot();

  const iconPaths = data['icon_paths.json'] || {};
  const icon = makeIconResolver(iconPaths);

  console.log('[transform] building documents…');
  const monsters = transformMonsters(data['monster_album_en-US.json'], icon);
  const equipment = transformEquipment(data['equipment_en-US.json'], icon);
  const cards = transformCards(data['handbook_cards_en-US.json'], data['monster_album_en-US.json'], icon);
  const maps = transformMaps(data['map_index_en-US.json'], data['map_monster_spawns_en-US.json'], icon);
  console.log(
    `[transform] monsters=${monsters.length} equipment=${equipment.length} cards=${cards.length} maps=${maps.length}` +
    ` (icons unresolved via icon_paths: ${icon.unresolvedCount()} — heuristic fallback used)`,
  );

  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 15_000, connectTimeoutMS: 15_000 });
  await client.connect();
  const db = client.db(DB_NAME);
  console.log(`[load] connected to MongoDB db="${DB_NAME}" — writing ONLY rodb_* collections`);

  try {
    const counts = {
      monsters: await upsertAll(db, 'rodb_monsters', monsters),
      equipment: await upsertAll(db, 'rodb_equipment', equipment),
      cards: await upsertAll(db, 'rodb_cards', cards),
      maps: await upsertAll(db, 'rodb_maps', maps),
    };

    if (!ALLOWED_COLLECTIONS.has('rodb_meta')) throw new Error('unreachable');
    await db.collection('rodb_meta').replaceOne(
      { _id: 'snapshot' },
      {
        _id: 'snapshot',
        assetVersion: info.assetVersion || 'unknown',
        locale: info.locale || 'en-US',
        source: info.source || `${BASE}/sea/`,
        snapshotFetchedAt: info.fetchedAt || null,
        importedAt: new Date(),
        counts,
      },
      { upsert: true },
    );
    console.log('[load] rodb_meta updated:', JSON.stringify(counts));
    console.log('=== Import complete ===');
  } finally {
    await client.close();
  }
}

main().catch((err) => {
  console.error('Import failed:', err);
  process.exit(1);
});
