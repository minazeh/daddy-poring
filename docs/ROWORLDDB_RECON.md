# RoworldDB Recon — Data Extraction Feasibility & Integration Plan

| | |
|---|---|
| **Author** | Kai |
| **Date** | 2026-07-03 |
| **Target** | https://roworlddb.com/sea/ (Ragnarok Online: World Tour community DB) |
| **Scope** | Monsters (Monster Album), Equipment, Cards, Maps — one-time snapshot |
| **Bot** | daddy-poring (`projects/discord-bot/`, Node.js + discord.js v14 + MongoDB Atlas, Railway) |
| **Status** | Recon complete. No scraper built, no bot code touched. Awaiting greenlight. |

---

## 1. Feasibility Verdict: **GREEN**

The entire site is a static front-end that loads all four target datasets as **plain, unauthenticated, locale-suffixed JSON files**. There is no scraping in the HTML-parsing sense — the "extraction" is **seven HTTP GETs totaling ~5.4 MB**. No headless browser, no API keys, no pagination, no HTML parsing.

## 2. Data-Access Method

- **Method that wins: static JSON data files** (option b-adjacent — not Next.js, just hand-rolled JS pages that `fetch()` flat JSON from `/sea/<section>/data/`).
- **Headless browser required: NO.** Verified by downloading every dataset with plain `curl` and a normal browser User-Agent. All returned HTTP 200 with full payloads.
- Each section page (`/sea/monster_album/`, `/sea/cards/`, `/sea/equipment/`, `/sea/maps/`) is a server-rendered shell + one page-specific JS file whose `CONFIG` block declares the data URL. Locale token is one of `zh-TW, en-US, zh-CN, th-TH, id-ID` — we use `en-US`.
- Cache-busting: pages append `?v=<asset-version>`; current version (from `<meta name="asset-version">`): **`20260702-135340`**. The query param is optional — bare URLs also return 200 — but recording the version stamps the snapshot.

### The complete download list (this IS the scrape)

| # | URL | Size | Contents |
|---|---|---|---|
| 1 | `/sea/monster-album/data/monster_album_en-US.json` | 4.05 MB | 2,673 monsters (meta + monsters[]) |
| 2 | `/sea/card-simulator/data/handbook_cards_en-US.json` | 123 KB | 226 cards + source filters |
| 3 | `/sea/equipment/data/equipment_en-US.json` | 1.09 MB | 2,664 items + all lookup dicts |
| 4 | `/sea/map-simulator/data/map_index_en-US.json` | 68 KB | 13 world maps + 354 map configs |
| 5 | `/sea/map-simulator/data/map_monster_spawns_en-US.json` | 36 KB | 36 spawn views, 102 spawn entries |
| 6 | `/sea/map-simulator/data/map_subregions_en-US.json` | 11 KB | 30 subregion polygon sets |
| 7 | `/sea/skill-simulator/data/icon_paths.json` | — | 7,597-entry icon-name → subpath map (needed to resolve image URLs) |

## 3. robots.txt / ToS / Licensing

- **robots.txt**: contains ONLY Cloudflare's "content signals" boilerplate comment block (search / ai-input / ai-train definitions). **Zero `User-agent`/`Disallow`/`Allow` directives, no sitemap.** Nothing is disallowed; no content signals are actually set (the boilerplate itself states that absent signals neither grant nor restrict).
- **ToS**: none found. Site has no footer, no about page, no visible terms or licensing statement on any fetched page.
- **Licensing reality check**: roworlddb is itself a fan/community site republishing game data owned by the game's publisher. Our snapshot of their JSON is one step further downstream. For a private guild Discord bot this is normal fan-tooling territory, but it is not "licensed data."
- **Anti-bot measures**: Cloudflare fronts the site (`Server: cloudflare`, `Cf-Cache-Status: DYNAMIC`) but issued **no challenges, no 403s, no rate-limit headers** across ~15 polite requests. Image hotlinks also return 200 to bare curl — no hotlink protection observed.
- **Recommendation**: add a small attribution line to the bot embeds' footer — `Data: roworlddb.com` — and keep total request volume trivially low (it already is: 7 requests for data; images are a separate decision, §8).

## 4. Per-Entity Findings

### 4.1 Monsters (Monster Album)

- **List pattern**: single JSON file — `monster_album_en-US.json` → `{ meta, monsters[] }`. No per-record pages exist; the site renders detail modals client-side from this same file. **List = detail.**
- **Size**: **2,673 monsters** (260 flagged `is_handbook`; 520 with `drops`; 22 with MVP drop tables; 203 tied to activities/events).
- **Field schema** (keys → presence out of 2,673):
  - Always: `id`, `name`, `level`, `type {id,name}` (Normal/Elite/MVP…), `race {id,name}`, `element {id,name}`, `body {id,name}` (size), `stats {hp, patk, matk, pdef, mdef, hit, flee, crit, critDef, aspd}`, `is_handbook`, `image` (icon name), `drop_rate_entries[]`, `mvp_drop_rate_entries[]`
  - Optional: `drops[]` (520), `guaranteed_card {item_id,name,icon,quality}` (328), `guaranteed_card_drop_progress` (199), `activities[]` (203), `activity_sources` (195)
  - `drops[]` entry: `{item_id, name, icon, quality, is_card?}`
  - `drop_rate_entries[]` entry: `{item_id, name, icon, quality, kind: item|card_variant|equipment_quality, variant?: bound|unbound, r, f}` — `r`/`f` are rate integers scaled ×10^8 (e.g. `r: 10000000` = 10%; `r: 21645` = 0.021645%).
- **Samples**:
  - `{id: 40001, name: "Poring", level: 5, type: Normal, race: Plant, element: Water, body: Medium, stats: {hp: 190, …}, drops: 10 items incl. Poring Card (is_card), drop_rate_entries: 12 rows w/ bound/unbound card variants, guaranteed_card: Poring Card, guaranteed_card_drop_progress: 4000}`
  - `{id: 999, name: "Poring (test drop only)", level: 15, race: Plant, element: Water, stats: {hp: 101, hit: 12500, …}, is_handbook: false, drops: none}` — the file includes non-handbook internal/event monsters; `is_handbook` and empty drops are the filters.
- **Name collisions**: 375 duplicate names (e.g. multiple "Goblin", "Baphomet" at different levels/variants) — autocomplete must disambiguate (see §10).
- **Image pattern**: `https://roworlddb.com/media/images/monster/<image>.webp` (e.g. `.../monster/icon_monster_head_boli_01.webp` — verified 200, `image/webp`, ~6 KB). Boss/summon/pet-prefixed icons live under `/media/images/boss/`, `/summon/`, `/pet/` respectively (per site JS routing); `icon_paths.json` resolves the rest.

### 4.2 Equipment

- **List pattern**: single JSON file — `equipment_en-US.json` → `items[]` plus lookup dictionaries that decode the ID-coded fields: `attributes` (71 stat defs), `jobs` (35), `conditions` (1,481 effect texts), `stunts` (61), `affixes` (86), `itemTypes` (17), `itemSubtypes` (24), `assemblyTypes` (16), `suits` (51 set definitions), `buffs` (5). **List = detail.**
- **Size**: **2,664 items** (1,636 handbook).
- **Field schema** (all 19 keys present on every item):
  `id`, `name`, `desc` (empty on ALL items — ignore), `icon`, `quality` (1–6), `isHandBook`, `itemType` (ID → e.g. 51 Head, 54 Armor, 69 Off-Hand, 70 Weapon, 201–206 shadow gear), `itemSubtype`, `assemblyType`, `openLevel`, `jobAll` (bool), `jobLimits[]` (job IDs), `stats[]` (pairs `[attrId, value]`), `buffs[]`, `conditions[]` (condition IDs → text like `"LUK +4, ATK +15"`), `stunts[]` (IDs → text), `fixedAffixes[]`, `refinePerLevel[]` (pairs `[attrId, value-per-refine]`), `suits[]` (suit IDs).
  - `attributes` values carry `percentage_show`/`reserve_number` flags — needed to render `Max HP% +5%` vs `HP +1710` correctly. Stat values appear ×100 where percentage (e.g. `[23, 500]` = Max HP% +5%).
- **Samples**:
  - `{id: 10433003, name: "Headwear: Starlit Dream", quality: 6, itemType: 51 (Head), jobAll: true, stats: [[201,200],[202,200]], refinePerLevel: [[29,4],[32,4]]}`
  - `{id: 56907402, name: "Royal Ancient Book of Geffenia", quality: 6, itemType: 69 (Off-Hand), openLevel: 70, jobLimits: [201,212,213,…] (23 jobs), stats: [[21,1710],[37,8]], conditions: [690740201…04], stunts: [100505]}`
- **Name collisions**: 547 duplicates (quality tiers of the same base item) — disambiguate by quality/type in autocomplete.
- **Data quirk**: `jobs` dict has placeholder entries (`"Job 101": "Job 101"`), and a few `stunts` texts are placeholders (`"t"`). Store as-is; render "—" when text is placeholder-ish.
- **Image pattern**: `https://roworlddb.com/media/images/item/<icon>.webp` for `icon_item_*`; `icon_equip_*`/others resolve via `icon_paths.json` (7,597 entries, e.g. `icon_equip_cloth_19` → its subfolder path). Verified 200.

### 4.3 Cards

- **List pattern**: single JSON file — `handbook_cards_en-US.json` → `{ monster_source_filters, obtain_source_filters, cards[] }`. **List = detail.**
- **Size**: **226 cards** (small — this is the handbook card set).
- **Field schema** (all 15 keys on every card):
  `id`, `name`, `quality` (2–5), `card_type_id`, `card_type_name` (slot: Weapon/Armor/Head/Face/Mouth/Cape/Shoes/Back/Accessory/Off-Hand), `effect` (e.g. `"LUK +4~7"`), `effect_extra`, `effect_lines[]`, `words_count`, `mini_icon`, `item_icon`, `obtain_source_tables[]`, `monster_class_filters[]`, `monster_source_filters[]`, `has_mvp_source`.
- **Cross-link**: the monster file's `drops[]` entries flagged `is_card: true` (328 entries) + `guaranteed_card` give the reverse **card → dropped-by-monsters** mapping, including bound/unbound drop rates from `drop_rate_entries` (`kind: "card_variant"`). Build this join at import time.
- **Samples**:
  - `{id: 12033001, name: "Novice Poring Card", quality: 4, card_type_name: "Mouth", effect: "LUK +4~7", effect_extra: "Includes up to 2 random affixes.", item_icon: "icon_item_card_bl_01", has_mvp_source: false}`
  - Poring Card (`id: 12333001`) appears in Poring's drops as `card_variant` bound `r=21645` / unbound `r=11655` (≈0.0216% / 0.0117%) with guaranteed pity at 4,000 kills.
- **Image pattern**: `https://roworlddb.com/media/images/item/<item_icon>.webp` (verified 200). `mini_icon` variant also exists for list views.

### 4.4 Maps

- **List pattern**: three JSON files (index + spawns + subregions). **List = detail.**
  - `map_index_en-US.json`: `world_maps[]` (13 regions: `{world_map_id, name, center_scene_id, pic_res}`) + `map_configs{}` keyed by scene ID (**354 entries, 353 named**): `{map_id, name, pic_res, scene_center_xz, scene_extent_xz, mini_map_center, mini_map_extent}`.
  - `map_monster_spawns_en-US.json`: `views{}` keyed by map_id (36 maps, 102 monster spawn entries): `{monster_id, name, family, icon, total_spawn_spots, collected_spawn_spots, markers[{scene_id,x,y,z}]}`. 100/102 monster_ids join cleanly to the monster album.
  - `map_subregions_en-US.json`: 30 maps with named-district polygon outlines (render-only; low bot value).
- **Size**: **354 maps** (353 named; 40 duplicate names across regions — e.g. two "Prontera" scenes — disambiguate by map_id/region).
- **Honest limitation**: spawn data covers only **36 of 354 maps** and is skewed to event content (Luminous Vale, mimics, etc.). A comprehensive "where does monster X spawn" lookup is **not** in this dataset. `/map` can show map info + known spawns; a global monster→map answer will be sparse. Flagged as open decision (§12).
- **Sample**: `{map_id: 101, name: "Eden Group"-adjacent scene… , pic_res: "icon_map_10001", mini_map_extent: [2048,2048]}`; world map `{world_map_id: 1, name: "Prontera", center_scene_id: 101, pic_res: "icon_map_10001"}`.
- **Image pattern**: `https://roworlddb.com/media/images/map/<pic_res>.webp` (verified 200) — these are the minimap/region images.

## 5. Dataset Size Summary

| Entity | Records | Raw JSON | Notes |
|---|---|---|---|
| Monsters | 2,673 | 4.05 MB | 260 handbook, 520 with drops, 22 MVP tables |
| Equipment | 2,664 | 1.09 MB | + lookup dicts (attributes/jobs/conditions/suits) |
| Cards | 226 | 123 KB | joinable to monster drops |
| Maps | 354 | 115 KB (3 files) | spawns only for 36 maps |
| **Total** | **5,917** | **~5.4 MB** | Trivial for Atlas free tier |

## 6. Anti-Bot / Politeness Observations

- Cloudflare present, never challenged plain curl with a browser UA. No rate-limit headers, no JS challenge, no CAPTCHA.
- Whole recon = ~15 requests over several minutes with 2–3 s gaps. The production snapshot needs only 7. Politeness plan: 2 s delay between file downloads, one retry with backoff, honest UA string (e.g. `daddy-poring-snapshot/1.0 (+contact)`), run once.

## 7. Recommended Extraction Approach

**One-time Node.js import script** (not Python — keeps everything in the bot's stack and reuses its `mongodb` driver, and the job is 7 GETs + transforms, not scraping):

`scripts/import-roworlddb.js` (repo already has a `scripts/` dir):
1. GET the 7 files (2 s apart), save raw copies to `data/roworlddb-snapshot/` (audit trail + re-import without re-hitting the site; record `asset-version`).
2. Transform (see §9): resolve equipment stat/condition/job/type IDs to display strings via the lookup dicts; scale drop rates (`r / 10^6` = percent); build card→monster reverse index; merge map index + spawns + world-map region; precompute `nameLower` and resolved `imageUrl` for every record (via `icon_paths.json`).
3. Bulk upsert into MongoDB Atlas (db `discordbot`), create indexes.
4. Print counts per collection as verification.

- **Estimated runtime**: under 60 seconds total (downloads ~15 s incl. delays; transform + insert of 5.9 k docs is seconds).
- **Refresh**: none needed (one-time snapshot per Conrad). Re-running the script is idempotent (upsert by `_id`) if a refresh is ever wanted.

## 8. Images — decision needed

Two options (open decision for Conrad, §12):
- **(a) Hotlink** `https://roworlddb.com/media/images/....webp` directly in embed `thumbnail`. Zero storage, zero work; Discord's proxy caches aggressively so origin load is small. Risk: icons break if the site dies/renames, and it leans on their bandwidth. webp renders fine in Discord embeds.
- **(b) Mirror** the ~3–4 k referenced icons (small webp files, likely 20–40 MB) into repo/CDN. Self-sufficient but a bigger, less polite crawl (thousands of requests) and more moving parts.

**Kai's recommendation: (a) hotlink**, with the attribution footer. It matches the "good citizen, low volume" posture — Discord proxies mean the site is hit roughly once per unique icon ever.

## 9. Proposed MongoDB Schema

Same Atlas cluster/db (`discordbot`), new read-only reference collections, own `MongoClient` per the established pattern (`roster/db.js` / `kudos/db.js` precedent: separate client, graceful degrade, `isReady()`).

Prefix `rodb_` to keep game-reference data visually separate from guild-operational collections:

```
rodb_monsters   — { _id: <id>, name, nameLower, level,
                    type, race, element, size,            // flattened names
                    stats: {hp, patk, matk, pdef, mdef, hit, flee, crit, critDef, aspd},
                    isHandbook, imageUrl,
                    drops: [{itemId, name, quality, isCard, ratePct, boundRatePct}],
                    mvpDrops: [...same shape],
                    guaranteedCard: {itemId, name, pityKills} | null,
                    activities: [names] }

rodb_equipment  — { _id: <id>, name, nameLower, quality, level: openLevel,
                    typeName, subtypeName,                 // resolved from itemTypes/itemSubtypes
                    jobs: [names] | "All",
                    stats: [{name, value, isPercent}],     // resolved via attributes dict
                    refineStats: [{name, valuePerLevel}],
                    effects: [strings],                    // resolved conditions + stunts texts
                    suit: {name, itemIds} | null,
                    imageUrl }

rodb_cards      — { _id: <id>, name, nameLower, quality,
                    slot: card_type_name,
                    effectLines: [strings], effectExtra,
                    droppedBy: [{monsterId, monsterName, level, ratePctUnbound, ratePctBound, guaranteed}],
                    hasMvpSource, imageUrl }

rodb_maps       — { _id: <map_id>, name, nameLower, region,       // world_map name
                    imageUrl,                                      // pic_res minimap
                    spawns: [{monsterId, name, spawnSpots}] }      // empty for most maps

rodb_meta       — { _id: "snapshot", assetVersion: "20260702-135340",
                    importedAt, counts: {...} }                    // provenance
```

**Indexes** (per collection): `{ nameLower: 1 }` — this is the workhorse for autocomplete prefix regex (`^query`, anchored regexes use the index). Add a `{ name: "text" }` text index per collection for fallback whole-word search when a prefix match misses. `_id` covers direct lookups from autocomplete selections.

## 10. Proposed Slash Commands

Follows the existing bot pattern exactly: each command is `commands/<name>.js` exporting `{ data: SlashCommandBuilder, execute }` — auto-loaded by the `commands/*.js` loader, auto-registered on boot. New module `rodb/db.js` mirrors `roster/db.js` (own MongoClient, `initSchema()` from `ready.js`, `isReady()` graceful degrade, read-only).

**Loader gap found (must-fix)**: `events/interactionCreate.js` currently exits at `if (!interaction.isChatInputCommand()) return;` — **autocomplete interactions are silently dropped**. Add before that line:

```js
if (interaction.isAutocomplete()) {
  const command = interaction.client.commands.get(interaction.commandName);
  if (command?.autocomplete) await command.autocomplete(interaction);
  return;
}
```

Command files then export an `autocomplete(interaction)` alongside `execute`. This is additive and cannot affect existing commands (none define autocomplete today).

### Commands

| Command | Options | Behavior |
|---|---|---|
| `/monster <name>` | string, required, autocomplete | Monster info embed |
| `/item <name>` | string, required, autocomplete | Equipment info embed |
| `/card <name>` | string, required, autocomplete | Card info embed |
| `/map <name>` | string, required, autocomplete | Map info embed |

**Autocomplete UX** (shared helper in `rodb/search.js`):
- On each keystroke: `find({ nameLower: /^<escaped query>/ }).limit(25)`; if <25 hits, top up with text-index search. Reply within Discord's 3 s window (indexed prefix query is ms).
- **Disambiguation is mandatory** (375 dup monster names, 547 dup equipment, 40 dup maps): choice label = `Name (Lv 5 · Normal)` for monsters, `Name (Q6 · Head)` for equipment, `Name (Prontera)` for maps; choice **value = `_id`** so execute() does an exact `_id` lookup, with a name-search fallback when the user types free text and hits Enter without picking.

**Embed sketches** (all embeds: footer `Data: roworlddb.com`, thumbnail = `imageUrl`, quality-tier accent color):

- `/monster` — title `Poring — Lv 5 Normal`; line 1 `Plant · Water · Medium`; stats as 2 rows of inline fields (HP/ATK/MATK/DEF/MDEF + Hit/Flee/Crit/CritDef/ASPD); **Drops** field: `item — 10%` lines, cards shown as `Poring Card — 0.022% (bound) / 0.012% (unbound) · pity 4,000`; MVP drops field when present.
- `/item` — title `Royal Ancient Book of Geffenia`; line 1 `Q6 Off-Hand · Lv 70 · 23 jobs` (or `All jobs`); **Stats** field (`HP +1710`, `Max HP% +5%` — percentage-aware); **Refine** field (`per +1: Refine ATK +4`); **Effects** field (resolved condition/stunt texts); **Set** field when in a suit.
- `/card` — title `Poring Card`; line 1 `Q2 · Mouth slot`; **Effect** field (effect_lines); **Dropped by** field (monster + level + bound/unbound rates + pity), `MVP source` badge when `hasMvpSource`.
- `/map` — title `Prontera South Gate`; line 1 `Region: Prontera`; image = minimap `pic_res` (as embed `image`, it's a big picture); **Known spawns** field or `No spawn data in snapshot` (honest — see §4.4).

`commands/help.js` gets 4 new entries (Community/everyone), matching how `/guildroster` was added.

## 11. Recommended Next Step

**Greenlight a single build task**: `scripts/import-roworlddb.js` (download + transform + load + indexes, ~1 session) → then the `rodb/` module + 4 commands + the autocomplete branch in `interactionCreate.js` (+ help entries) as a second task. Both verifiable locally against Atlas read-only-style (import writes only `rodb_*` collections; zero touches to members/parties/kudos). Stage for Nanna review per AIT pattern; one Railway redeploy registers the commands.

## 12. Open Decisions for Conrad

1. **Images: hotlink vs mirror** (§8). Kai recommends hotlink + attribution footer.
2. **Monster scope**: import all 2,673 (incl. non-handbook event/dungeon variants — better search coverage, duplicate-heavy autocomplete) or handbook-only 260 (clean but misses most real monsters players fight). Kai recommends **all**, with autocomplete disambiguation carrying the load.
3. **Locale**: en-US assumed. Other locales (zh-TW, th-TH, id-ID…) exist as parallel files if guild members want another language later.
4. **Map spawn sparseness** (§4.4): accept `/map` with sparse spawn data, or drop the spawns field entirely and keep `/map` as region/minimap info only.
5. **Attribution**: confirm `Data: roworlddb.com` footer is wanted on every embed.
