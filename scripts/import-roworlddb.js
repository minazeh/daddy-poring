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
//   rodb_skills     (~276)     rodb_runes     (~33)
//   rodb_refine     (20)       rodb_pets      (28)
//   rodb_shop       (~599)
//   rodb_meta       (snapshot + per-section provenance + refine config)
//
// Tier A/B extension (docs/ROWORLDDB_RECON.md §13): skills (48 per-job files,
// deduped by globally-unique skill key), runes (effect groups + element
// resonance), refine (per-level odds + materials), pets, shop. Cross-links
// precomputed at import: equipment.rollableAffixes (exact subtype/assembly +
// openLevel bracket join into the affix stunt packages) and monster.foundIn
// (reverse of the sparse map spawn views).
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
  // Tier A extension datasets (all confirmed static/clean — recon §13).
  { name: 'skills_index_en-US.json',       url: `${BASE}/sea/skill-simulator/data/skills_index_en-US.json` },
  { name: 'engine_runes_en-US.json',       url: `${BASE}/sea/skill-simulator/data/engine_runes_en-US.json` },
  { name: 'stunt_skill_library_en-US.json', url: `${BASE}/sea/affix-simulator/data/stunt_skill_library_en-US.json` },
  { name: 'stunt_package_index_en-US.json', url: `${BASE}/sea/affix-simulator/data/stunt_package_index_en-US.json` },
  { name: 'refine_en-US.json',             url: `${BASE}/sea/refine-simulator/data/refine_en-US.json` },
  { name: 'pet_library_en-US.json',        url: `${BASE}/sea/pet/data/pet_library_en-US.json` },
  { name: 'shop_en-US.json',               url: `${BASE}/sea/shop/data/shop_en-US.json` },
];

// The ONLY collections this script may touch. coll() asserts against this list.
const ALLOWED_COLLECTIONS = new Set([
  'rodb_monsters', 'rodb_equipment', 'rodb_cards', 'rodb_maps', 'rodb_meta',
  'rodb_skills', 'rodb_runes', 'rodb_refine', 'rodb_pets', 'rodb_shop',
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

// Per-job skill files (jobs_en-US/<job_id>.json — one per job in the skills
// index). Same reuse-on-disk / polite-fetch rules as ensureSnapshot.
async function ensureJobFiles(skillsIndex) {
  const dir = path.join(SNAPSHOT_DIR, 'jobs_en-US');
  fs.mkdirSync(dir, { recursive: true });
  const jobFiles = [];
  let fetchedAny = false;
  for (const jobId of Object.keys(skillsIndex.jobs || {})) {
    const file = path.join(dir, `${jobId}.json`);
    let json = fs.existsSync(file) ? readJsonIfValid(file) : null;
    if (!json) {
      if (fetchedAny) await sleep(FETCH_DELAY_MS);
      const url = `${BASE}/sea/skill-simulator/data/jobs_en-US/${jobId}.json`;
      console.log(`[snapshot] fetching ${url}`);
      const text = await fetchWithRetry(url);
      json = JSON.parse(text);
      fs.writeFileSync(file, text);
      fetchedAny = true;
    }
    jobFiles.push(json);
  }
  console.log(`[snapshot] job skill files ready: ${jobFiles.length}`);
  return jobFiles;
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

function transformMonsters(album, icon, foundInByMonster = new Map()) {
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
    // Tier B: maps this monster spawns on (sparse — 36/354 maps have views).
    foundIn: foundInByMonster.get(m.id) || [],
  }));
}

// Placeholder texts the equipment dicts contain ("t", "2", "Stunt 100205", "Job 101").
const isPlaceholderText = (t) =>
  !t || t.length < 3 || /^stunt \d+$/i.test(t) || /^\d+$/.test(t);
const isPlaceholderJob = (n) => !n || /^job \d+$/i.test(n);

function transformEquipment(eq, icon, affixesFor = () => []) {
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
      // Tier B: affixes that can roll on this exact item tier (recon §13.6).
      rollableAffixes: affixesFor(it),
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
// Tier A/B transforms (recon §13)
// ---------------------------------------------------------------------------

// Skill/rune/pet descriptions carry Unity rich-text markup — strip to plain.
const stripMarkup = (s) =>
  typeof s === 'string'
    ? s.replace(/<color=#?[0-9a-zA-Z]+>/g, '').replace(/<\/color>/g, '').replace(/<\/?b>/g, '').trim()
    : null;

// Skills: 48 per-job files; skill keys are globally unique and repeat down a
// class line (Knight → Lord Knight → Rune Knight) with byte-identical content
// (verified) — dedupe by key, accumulate the job list.
function transformSkills(jobFiles, icon) {
  const docs = new Map();
  const KINDS = [
    ['skills', 'Skill'],
    ['unique_skills', 'Unique'],
    ['traits', 'Trait'],
  ];
  for (const jf of jobFiles) {
    const jobName = jf.job_name || `Job ${jf.job_id}`;
    for (const [cat, kind] of KINDS) {
      for (const [key, s] of Object.entries(jf[cat] || {})) {
        const id = Number(key);
        if (!Number.isFinite(id)) continue;
        const existing = docs.get(id);
        if (existing) {
          if (!existing.jobIds.includes(jf.job_id)) {
            existing.jobIds.push(jf.job_id);
            existing.jobs.push(jobName);
            existing.jobsLower.push(jobName.toLowerCase());
          }
          continue;
        }
        const levels = Object.entries(s.levels || {})
          .map(([lv, d]) => ({
            level: Number(lv),
            skillId: d.skill_id ?? null,
            desc: stripMarkup(d.des),
            spCost: d.mana_cost ?? null,
            cooldownMs: d.cooldown ?? null,
            rangeMax: d.range_max ?? null,
          }))
          .sort((a, b) => a.level - b.level);
        const lv1 = (s.levels || {})['1'] || {};
        docs.set(id, {
          _id: id,
          name: s.name ?? null,
          nameLower: lower(s.name),
          kind,
          jobs: [jobName],
          jobsLower: [jobName.toLowerCase()],
          jobIds: [jf.job_id],
          description: stripMarkup(s.skilldes),
          naturalMaxLevel: s.natural_max_level ?? null,
          maxLevel: s.max_level ?? null,
          tags: (lv1.skill_tags || []).map((t) => t.name).filter(Boolean),
          imageUrl: icon(s.icon, 'skill'),
          levels,
        });
      }
    }
  }
  return [...docs.values()];
}

// Runes: the lookup entity is the named effect group (33). Element/crystal
// resonance is resolved from the level-1 elementId. Rune ("ember") icons are
// NOT in icon_paths — the site builds `${emberBasePath}${icon}_${color}.webp`
// (verified 200 for icon_ember_01_3/4/5.webp; bare icon_ember_01.webp is 404).
function transformRunes(runes) {
  const elements = runes.elements || {};
  return Object.values(runes.effectGroups || {}).map((g) => {
    const rawLevels = Object.values(g.levels || {}).sort((a, b) => (a.level ?? 0) - (b.level ?? 0));
    const levels = rawLevels.map((l) => ({
      level: l.level,
      desc: stripMarkup(l.desc),
      color: l.color ?? null,
    }));
    const el = elements[String(rawLevels[0]?.elementId ?? '')] || null;
    const iconColor = rawLevels[0]?.color;
    return {
      _id: g.group,
      name: g.name ?? null,
      nameLower: lower(g.name),
      imageUrl: g.icon && iconColor != null
        ? `${IMAGE_BASE}ember/${g.icon}_${iconColor}.webp`
        : null,
      element: el
        ? { id: el.id, name: el.name ?? null, resonance: el.resonance ?? null }
        : null,
      levels,
    };
  });
}

// Refine: 20 per-level docs (_id = current level). Global config (safe levels,
// pity, tier groups) goes to rodb_meta as 'refine_config'.
function transformRefine(refine) {
  const iconUrl = (obj) => (obj?.iconPath ? `${BASE}${obj.iconPath}` : null);
  const levels = (refine.levels || []).map((l) => ({
    _id: l.level,
    targetLevel: l.targetLevel ?? l.level + 1,
    successPct: l.success ?? null,
    downgradePct: l.downgrade ?? null,
    failPct: l.fail ?? null,
    material: l.material?.item
      ? {
          itemId: l.material.item.itemId,
          name: l.material.item.name ?? null,
          quality: l.material.item.quality ?? null,
          amount: l.material.amount ?? null,
          imageUrl: iconUrl(l.material.item),
          replaceCurrencyAmount: l.material.replaceCurrency?.amount ?? null,
        }
      : null,
    consumable: l.consumable?.item
      ? { name: l.consumable.item.name ?? null, amount: l.consumable.amount ?? null }
      : null,
  }));
  const config = {
    _id: 'refine_config',
    maxLevel: refine.maxLevel ?? null,
    safeLevels: refine.safeLevels || [],
    pityBonuses: refine.pityBonuses || {},
    replacementCurrency: refine.replacementCurrency?.name ?? null,
    groups: (refine.groups || []).map((gr) => ({
      label: gr.label ?? gr.key ?? null,
      startLevel: gr.startLevel ?? null,
      endLevel: gr.endLevel ?? null,
      material: gr.material?.name ?? null,
    })),
  };
  return { levels, config };
}

// Pets: 28. Keep level buffs (max-level attr totals), named per-level skill
// unlocks, and the current-max form of each combat skill.
function transformPets(petFile) {
  return (petFile.pets || []).map((p) => {
    const levels = Array.isArray(p.levels) ? p.levels : [];
    const withAttrs = levels.filter((l) => (l.skill?.attrs || []).length);
    const maxAttrs = withAttrs.length ? withAttrs[withAttrs.length - 1] : null;
    const namedUnlocks = levels
      .filter((l) => l.skill?.name)
      .map((l) => ({ level: l.level, name: l.skill.name, desc: stripMarkup(l.skill.description) }));
    const combatSkills = (p.combatSkills || []).map((cs) => {
      const unlocks = cs.unlocks || [];
      const top = unlocks.length ? unlocks[unlocks.length - 1].skill : null;
      return top
        ? {
            typeLabel: cs.typeLabel ?? null,
            name: top.name ?? null,
            desc: stripMarkup(top.description),
            cooldownSeconds: top.cooldownSeconds ?? null,
            element: top.elementName ?? null,
            maxUnlockLevel: unlocks[unlocks.length - 1].level ?? null,
          }
        : null;
    }).filter(Boolean);
    return {
      _id: p.id,
      name: p.name ?? null,
      nameLower: lower(p.name),
      qualityTag: p.quality?.tag ?? null,
      qualityName: p.quality?.name ?? null,
      imageUrl: p.iconUrl ? `${BASE}${p.iconUrl}` : null,
      maxLevel: levels.length ? levels[levels.length - 1].level : null,
      battleStats: p.battleStats ?? null,
      maxLevelBuffs: maxAttrs
        ? {
            level: maxAttrs.level,
            attrs: (maxAttrs.skill.attrs || []).map((a) => ({
              name: a.name,
              value: a.value,
              isPercent: !!a.isPercentage,
              target: a.target ?? null,
            })),
          }
        : null,
      namedUnlocks,
      combatSkills,
    };
  });
}

// Shop: 599 listings across 25 NPC stores; _id = listing id (itemId repeats
// across stores). purchaseOptions carry resolved currency names.
function transformShop(shop) {
  return (shop.items || []).map((s) => ({
    _id: s.id,
    itemId: s.itemId ?? null,
    name: s.name ?? null,
    nameLower: lower(s.name),
    desc: s.desc || null,
    story: s.story || null,
    quality: s.quality ?? null,
    imageUrl: s.iconPath ? `${BASE}${s.iconPath}` : null,
    store: s.storeName ?? null,
    tab: s.tabName ?? null,
    itemNum: s.itemNum ?? null,
    prices: (s.purchaseOptions || []).map((o) => ({
      currency: o.currencyName ?? null,
      amount: o.amount ?? null,
      mode: o.mode ?? null,
    })),
    limitNum: s.limitNum ?? null,
    requiredLevel: s.requiredLevel ?? null,
    binding: s.binding === 1,
    unlockNotes: (s.showUnlockDescriptions || []).filter(Boolean),
  }));
}

// ---------------------------------------------------------------------------
// Tier B cross-link builders
// ---------------------------------------------------------------------------

// equipment → rollable affixes. Exact join (recon §13.6): weapon itemSubtype
// ids (7001–7021) ARE the package-index weapon_type keys, armor/cape
// assemblyType (4/7) ARE the armor package keys, and openLevels match the
// bracket keys exactly. Anything that doesn't match exactly gets NO field —
// never approximate a bracket.
function makeAffixResolver(stuntLib, pkgIndex) {
  const packages = stuntLib.packages || {};
  const weaponPkgs = pkgIndex.weapon_packages_by_type_and_level || {};
  const armorPkgs = pkgIndex.armor_packages_by_type_and_level || {};
  return (item) => {
    const lvl = String(item.openLevel ?? '');
    const pkgIds =
      weaponPkgs[String(item.itemSubtype)]?.[lvl] ||
      armorPkgs[String(item.assemblyType)]?.[lvl] ||
      null;
    if (!Array.isArray(pkgIds) || !pkgIds.length) return [];
    const names = new Map(); // name -> max level seen
    for (const pid of pkgIds) {
      for (const e of packages[String(pid)]?.entries || []) {
        const st = e.stunt;
        if (!st?.name) continue;
        const prev = names.get(st.name) || 0;
        if ((st.level || 0) > prev) names.set(st.name, st.level || 0);
      }
    }
    return [...names.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([name, maxLevel]) => ({ name, maxLevel }));
  };
}

// monster → maps it spawns on (reverse of the sparse 36/354 spawn views).
function buildMonsterFoundIn(maps) {
  const byMonster = new Map();
  for (const m of maps) {
    for (const s of m.spawns || []) {
      if (!byMonster.has(s.monsterId)) byMonster.set(s.monsterId, []);
      byMonster.get(s.monsterId).push({
        mapId: m._id,
        mapName: m.name,
        region: m.region,
        spawnSpots: s.spawnSpots ?? null,
      });
    }
  }
  return byMonster;
}

// ---------------------------------------------------------------------------
// Load
// ---------------------------------------------------------------------------

async function upsertAll(db, collName, docs, { nameIndexes = true, extraIndexes = [] } = {}) {
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
  if (nameIndexes) {
    await coll.createIndex({ nameLower: 1 });
    await coll.createIndex({ name: 'text' });
  }
  for (const idx of extraIndexes) {
    await coll.createIndex(idx);
  }
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
  const jobFiles = await ensureJobFiles(data['skills_index_en-US.json'] || { jobs: {} });

  const iconPaths = data['icon_paths.json'] || {};
  const icon = makeIconResolver(iconPaths);

  console.log('[transform] building documents…');
  const maps = transformMaps(data['map_index_en-US.json'], data['map_monster_spawns_en-US.json'], icon);
  const foundIn = buildMonsterFoundIn(maps);
  const monsters = transformMonsters(data['monster_album_en-US.json'], icon, foundIn);
  const affixesFor = makeAffixResolver(
    data['stunt_skill_library_en-US.json'] || {},
    data['stunt_package_index_en-US.json'] || {},
  );
  const equipment = transformEquipment(data['equipment_en-US.json'], icon, affixesFor);
  const cards = transformCards(data['handbook_cards_en-US.json'], data['monster_album_en-US.json'], icon);
  const skills = transformSkills(jobFiles, icon);
  const runes = transformRunes(data['engine_runes_en-US.json'] || {});
  const refine = transformRefine(data['refine_en-US.json'] || {});
  const pets = transformPets(data['pet_library_en-US.json'] || {});
  const shop = transformShop(data['shop_en-US.json'] || {});
  console.log(
    `[transform] monsters=${monsters.length} equipment=${equipment.length} cards=${cards.length} maps=${maps.length}` +
    ` skills=${skills.length} runes=${runes.length} refine=${refine.levels.length} pets=${pets.length} shop=${shop.length}` +
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
      skills: await upsertAll(db, 'rodb_skills', skills),
      runes: await upsertAll(db, 'rodb_runes', runes),
      refine: await upsertAll(db, 'rodb_refine', refine.levels, { nameIndexes: false }),
      pets: await upsertAll(db, 'rodb_pets', pets),
      shop: await upsertAll(db, 'rodb_shop', shop, { extraIndexes: [{ itemId: 1 }] }),
    };

    if (!ALLOWED_COLLECTIONS.has('rodb_meta')) throw new Error('unreachable');
    const meta = db.collection('rodb_meta');
    await meta.replaceOne(
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
    // Per-section provenance (assetVersion is site-global; recorded per
    // section so a future partial refresh can stamp sections independently).
    for (const [section, count] of Object.entries(counts)) {
      await meta.replaceOne(
        { _id: `section_${section}` },
        {
          _id: `section_${section}`,
          assetVersion: info.assetVersion || 'unknown',
          importedAt: new Date(),
          count,
        },
        { upsert: true },
      );
    }
    // Refine global config (safe levels, pity bonuses, tier groups).
    await meta.replaceOne({ _id: 'refine_config' }, refine.config, { upsert: true });
    console.log('[load] rodb_meta updated:', JSON.stringify(counts));
    console.log('=== Import complete ===');
  } finally {
    await client.close();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('Import failed:', err);
    process.exit(1);
  });
}

// Exported for offline verification (scripts run main() only when invoked
// directly via `node scripts/import-roworlddb.js`).
module.exports = {
  transformMonsters,
  transformEquipment,
  transformCards,
  transformMaps,
  transformSkills,
  transformRunes,
  transformRefine,
  transformPets,
  transformShop,
  makeAffixResolver,
  buildMonsterFoundIn,
  makeIconResolver,
  ALLOWED_COLLECTIONS,
};
