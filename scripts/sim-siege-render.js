// ---------------------------------------------------------------------------
// Sim / verification for the /siege renderer. Builds synthetic siege data (no
// Mongo, no network) and asserts the contract:
//   * EXACTLY ONE image per run.
//   * EACH RAID OCCUPIES ITS OWN ROW BAND — the whole point of the grouped
//     layout — including the degenerate cases (a raid with 1 party, a raid with
//     0). This is asserted structurally: every card in a block must belong to
//     that block's raid.
//   * Empty parties are HIDDEN, so a short raid draws a short row.
//   * 1920px wide, under the 8MB attachment cap.
// Writes sample PNGs to a scratch dir so the output can actually be LOOKED at —
// text assertions alone don't catch typography defects.
// Run: node scripts/sim-siege-render.js
// ---------------------------------------------------------------------------
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  buildSiegeImage, layoutRaidGroups, layoutSection, fitRows,
  WIDTH, MAX_BYTES, RAID_LABEL_H,
} = require('../roster/render');

const OUT_DIR = process.argv[2] || path.join(os.tmpdir(), 'siege-sim');
fs.mkdirSync(OUT_DIR, { recursive: true });

let failures = 0;
function assert(cond, msg) {
  if (cond) console.log(`  ok  - ${msg}`);
  else { console.error(`  FAIL - ${msg}`); failures++; }
}

// PNG header decode: bytes 16..24 are width/height big-endian in IHDR.
function pngSize(buf) {
  if (buf.slice(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new Error('not a PNG');
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

// ---- Synthetic data --------------------------------------------------------
const RAIDS = [
  { key: 'alpha', name: 'Alpha' },
  { key: 'bravo', name: 'Bravo' },
  { key: 'charlie', name: 'Charlie' },
  { key: 'delta', name: 'Delta Flex' },
];
const PARTY_SIZE = 5;
const settings = { requiredClasses: [{ className: 'Priest', min: 1 }], partySize: PARTY_SIZE };

// 400 members, deterministic classes: every 7th Priest, every 5th Knight,
// every 3rd Paladin, the rest Wizard. Names vary in length so truncation shows.
const members = [];
for (let i = 1; i <= 400; i++) {
  const cls = i % 7 === 0 ? 'Priest' : i % 5 === 0 ? 'Knight' : i % 3 === 0 ? 'Paladin' : 'Wizard';
  const name = i % 11 === 0 ? `LongPlayerName${i}xxxxx` : `Player${i}`;
  members.push({ userId: `u${i}`, username: name, displayName: name, className: cls });
}

// counts: filled parties per raid, in RAIDS order. `withLeader`: raid indexes
// that get a leader (the leader is the first member of the raid's first party).
function makeSiege(guild, counts, opts = {}) {
  const { withLeader = [0, 1, 2, 3], seedAll = true } = opts;
  const siegeRaids = [];
  const siegeParties = [];
  let uid = 0;
  RAIDS.forEach((r, ri) => {
    const raidId = `${guild}-siege-${r.key}`;
    const filled = counts[ri];
    let leaderId = null;
    // All 8 parties are always SEEDED (that's what the web app does); the ones
    // past `filled` are empty and must be hidden by the renderer.
    for (let p = 0; p < 8; p++) {
      const memberIds = [];
      if (p < filled) {
        for (let k = 0; k < PARTY_SIZE; k++) memberIds.push(`u${++uid + ri * 60}`);
        if (ri === 2 && p === 1) {
          // Raid 2 / party 2 is deliberately Priest-less so the rose "MISSING
          // required class" card is exercised inside the grouped layout.
          memberIds.splice(0, memberIds.length, 'u1', 'u2', 'u3', 'u4', 'u5');
        } else {
          memberIds[0] = 'u7'; // guarantee the required Priest everywhere else
        }
      }
      if (p === 0 && filled > 0) leaderId = memberIds[1] || null;
      if (seedAll || memberIds.length) {
        siegeParties.push({
          partyId: `${raidId}-p${p}`, type: guild, raidId, raidKey: r.key,
          name: `Party ${p + 1}`, memberIds, position: p, lockedSlots: [],
        });
      }
    }
    siegeRaids.push({
      raidId, type: guild, raidKey: r.key, name: r.name, position: ri,
      leaderId: withLeader.includes(ri) ? leaderId : null,
    });
  });
  return { members, siegeRaids, siegeParties, settings };
}

// THE core check: every card drawn inside a block belongs to that block's raid,
// and there is exactly one block per raid, in order.
function assertRaidPerRow(label, data, image) {
  const groups = [];
  const byRaid = new Map();
  for (const p of data.siegeParties) {
    if (!p.memberIds.length) continue;
    const l = byRaid.get(p.raidId);
    if (l) l.push(p); else byRaid.set(p.raidId, [p]);
  }
  const ordered = data.siegeRaids.slice().sort((a, b) => a.position - b.position);
  for (const r of ordered) groups.push({ name: r.name, parties: byRaid.get(r.raidId) || [] });
  const L = layoutRaidGroups(groups);

  assert(L.blocks.length === ordered.length,
    `${label}: one block per raid (${L.blocks.length} blocks / ${ordered.length} raids)`);

  let pure = true;
  const shape = [];
  L.blocks.forEach((b, i) => {
    const raidId = ordered[i].raidId;
    const cells = b.rows.flatMap(r => r.cells);
    shape.push(`${ordered[i].name}:${cells.length}`);
    for (const c of cells) if (!c.p.partyId.startsWith(`${raidId}-p`)) pure = false;
  });
  assert(pure, `${label}: every card in a raid's block belongs to that raid — no straddling rows`);
  console.log(`      blocks: ${shape.join('  |  ')}   cols=${L.cols} cardW=${L.cardW.toFixed(1)}px`);

  const { width, height } = pngSize(image.buffer);
  const file = path.join(OUT_DIR, image.filename);
  fs.writeFileSync(file, image.buffer);
  assert(width === WIDTH, `${label}: PNG width === 1920 (got ${width})`);
  assert(image.buffer.length < MAX_BYTES, `${label}: bytes < 8MB (got ${image.buffer.length})`);
  console.log(`      -> ${file}  (${width}x${height}, ${(image.buffer.length / 1024).toFixed(1)} KB)`);
  return { width, height, bytes: image.buffer.length, layout: L };
}

// ---- Cases -----------------------------------------------------------------
const CASES = [
  { label: 'A. full siege (4 x 8 parties, 160 members)', guild: 'daddy', counts: [8, 8, 8, 8], file: 'siege-A-full' },
  { label: 'B. realistic (Delta Flex at 6)', guild: 'daddy', counts: [8, 8, 8, 6], file: 'siege-B-delta6' },
  { label: 'C. lopsided (7 / 8 / 3 / 1)', guild: 'daddy', counts: [7, 8, 3, 1], file: 'siege-C-lopsided' },
  { label: 'D. near-empty (one party in Alpha only)', guild: 'mummy', counts: [1, 0, 0, 0], file: 'siege-D-nearempty' },
  { label: 'E. seeded but wholly empty', guild: 'mummy', counts: [0, 0, 0, 0], file: 'siege-E-empty' },
];

const results = [];
for (const c of CASES) {
  console.log(`\n[${c.label}]`);
  const data = makeSiege(c.guild, c.counts);
  const image = buildSiegeImage(c.guild, data);
  assert(image !== null, `${c.label}: an image is produced`);
  assert(!Array.isArray(image), `${c.label}: EXACTLY ONE image (not an album)`);
  const drawn = data.siegeParties.filter(p => p.memberIds.length).length;
  assert(image.partyCount === drawn,
    `${c.label}: empty parties hidden — ${image.partyCount} cards for ${drawn} filled parties`);
  image.filename = `${c.file}.png`;
  results.push([c.label, assertRaidPerRow(c.label, data, image)]);
}

console.log('\n[F. never set up on the web side — no docs at all]');
assert(buildSiegeImage('daddy', { members, siegeRaids: [], siegeParties: [], settings }) === null,
  'F: no raid docs and no party docs → null (command replies in text, no crash)');
assert(buildSiegeImage('daddy', { members: [], siegeRaids: [], siegeParties: [], settings: null }) === null,
  'F: no members and no settings either → still null, no throw');

console.log('\n[G. orphan parties whose raid doc is missing are still drawn]');
{
  const data = makeSiege('daddy', [8, 8, 8, 6]);
  const orphaned = { ...data, siegeRaids: data.siegeRaids.slice(0, 3) };
  const img = buildSiegeImage('daddy', orphaned);
  assert(img && img.raidCount === 4, `G: 3 raid docs + 1 orphan raidId → 4 blocks (got ${img && img.raidCount})`);
}

console.log('\n[H. leader is named on the raid band and validated]');
{
  const data = makeSiege('daddy', [8, 8, 8, 6], { withLeader: [0, 2] });
  const withLeaders = buildSiegeImage('daddy', data);
  // A leaderId that isn't in any of its raid's parties must be ignored.
  const stale = {
    ...data,
    siegeRaids: data.siegeRaids.map(r => ({ ...r, leaderId: r.position === 1 ? 'nobody' : r.leaderId })),
  };
  const staleImg = buildSiegeImage('daddy', stale);
  assert(staleImg.buffer.length > 0, 'H: a stale leaderId renders without throwing (crown degrades to none)');
  assert(withLeaders.raids[0].leaderName && withLeaders.raids[2].leaderName,
    'H: Alpha and Charlie bands name their leader');
  assert(!withLeaders.raids[1].leaderName && !withLeaders.raids[3].leaderName,
    'H: Bravo and Delta Flex bands name no leader');
  assert(!staleImg.raids[1].leaderName, "H: a leaderId not in the raid own parties is not named");

  // Cross-raid stale id: Bravo's leaderId is set to ALPHA's (valid) leader. The
  // guild-wide leader set contains it, but it is not in any Bravo party, so
  // Bravo's band must still show no leader.
  const crossed = {
    ...data,
    siegeRaids: data.siegeRaids.map(r => (
      r.position === 1 ? { ...r, leaderId: data.siegeRaids[0].leaderId } : r
    )),
  };
  const crossedImg = buildSiegeImage('daddy', crossed);
  assert(!crossedImg.raids[1].leaderName,
    "H: another raid leader id is not crowned on this raid band");
  fs.writeFileSync(path.join(OUT_DIR, 'siege-H-leaders.png'), withLeaders.buffer);
  console.log(`      -> ${path.join(OUT_DIR, 'siege-H-leaders.png')} — eyeball: gold "Leader: <name>" on Alpha + Charlie bands ONLY`);
}

// ---- The reason the grouped layout exists ----------------------------------
// Documented, not just asserted: the flat pooling layout the other two commands
// use produces rows that straddle two raids the moment the raids differ in
// size. This is what /siege would look like if it reused layoutSection().
console.log('\n[I. why layoutSection() cannot do this — flat pooling straddles raids]');
{
  const counts = [7, 8, 3, 1];
  const data = makeSiege('daddy', counts);
  const pooled = data.siegeParties.filter(p => p.memberIds.length);
  const flat = layoutSection(pooled, fitRows(pooled.length), RAID_LABEL_H);
  const cells = flat.rows.map(r => {
    const keys = new Set(r.cells.map(c => c.p.raidKey));
    return `[${[...keys].join('+')}]`;
  });
  console.log(`      flat pooling of ${pooled.length} parties → ${flat.rows.length} rows: ${cells.join(' ')}`);
  const straddles = flat.rows.some(r => new Set(r.cells.map(c => c.p.raidKey)).size > 1);
  assert(straddles, 'I: confirmed — flat pooling mixes raids in a row (grouped layout is required)');
}

console.log('\n---- summary ----');
for (const [label, r] of results) {
  console.log(`  ${r.width}x${r.height}  ${(r.bytes / 1024).toFixed(1).padStart(7)} KB   ${label}`);
}
console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'} — samples in ${OUT_DIR}`);
process.exit(failures === 0 ? 0 : 1);
