// ---------------------------------------------------------------------------
// Sim / verification for the redesigned /guildroster renderer (STAGED build).
// Builds synthetic roster data and asserts the new 2-image, 1920-wide, ≤2-row
// contract. Writes sample PNGs to scratch and decodes their headers to confirm
// geometry. Run: node scripts/sim-guildroster-render.js
// ---------------------------------------------------------------------------
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  buildRaidImages, layoutSection, isEmptyParty, WIDTH, MAX_ROWS, MAX_BYTES,
} = require('../roster/render');

const OUT_DIR = path.join(os.tmpdir(), 'guildroster-sim');
fs.mkdirSync(OUT_DIR, { recursive: true });

let failures = 0;
function assert(cond, msg) {
  if (cond) { console.log(`  ok  - ${msg}`); }
  else { console.error(`  FAIL - ${msg}`); failures++; }
}

// PNG header decode: bytes 16..24 are width/height big-endian in the IHDR chunk.
function pngSize(buf) {
  if (buf.slice(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new Error('not a PNG');
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

// ---- Synthetic data --------------------------------------------------------
// Classes: Knight=tank, Priest=healer, others=dps. Required default = Priest×1.
function member(userId, displayName, className) {
  return { userId, username: displayName, displayName, className };
}
function party(partyId, field, name, position, memberIds) {
  return { partyId, type: 'daddy', field, name, position, memberIds };
}

const members = [];
for (let i = 1; i <= 120; i++) {
  const cls = i % 7 === 0 ? 'Priest' : i % 5 === 0 ? 'Knight' : 'Wizard';
  members.push(member(`u${i}`, `Player${i}`, cls));
}

const parties = [];
let uid = 1;
// Known-Priest id: u7 (7%7===0). Known non-Priest ids: u1..u6 (none %7===0).
const NON_PRIEST = ['u1', 'u2', 'u3', 'u4', 'u5', 'u6'];
function mkParty(id, field, name, pos, size, withPriest = true) {
  const ids = [];
  for (let k = 0; k < size; k++) { uid++; ids.push(NON_PRIEST[k % NON_PRIEST.length]); }
  // Ensure exactly-one Priest present when withPriest, else guarantee missing.
  if (withPriest) ids[0] = 'u7';
  return party(id, field, name, pos, ids);
}

// MAIN field: 1 raid with 2 parties + 1 unassigned = 3 non-empty parties.
parties.push(mkParty('daddy-main-1', 'main', 'Alpha', 1, 5, true));
parties.push(mkParty('daddy-main-2', 'main', 'Bravo', 2, 5, false)); // missing-class card
parties.push(mkParty('daddy-main-9', 'main', 'MainUnassigned', 9, 4, true));
// An EMPTY main party — must be excluded.
parties.push(party('daddy-main-3', 'main', 'EmptyGhost', 3, []));

// SUB field: 9 non-empty parties (stress the column math).
for (let i = 1; i <= 9; i++) {
  parties.push(mkParty(`daddy-sub-${i}`, 'sub', `Sub${i}`, i, 5, i !== 4));
}

const raidGroups = [
  { raidGroupId: 'rg-main-1', type: 'daddy', field: 'main', name: 'Raid One', partyIds: ['daddy-main-1', 'daddy-main-2', 'daddy-main-3'], position: 1 },
  { raidGroupId: 'rg-sub-1', type: 'daddy', field: 'sub', name: 'Sub Raid', partyIds: ['daddy-sub-1', 'daddy-sub-2', 'daddy-sub-3', 'daddy-sub-4', 'daddy-sub-5'], position: 1 },
];

const settings = { requiredClasses: [{ className: 'Priest', min: 1 }], partySize: 5 };

// ---- Run -------------------------------------------------------------------
console.log('\n[1] buildRaidImages(daddy) — normal-ish roster');
const imgs = buildRaidImages('daddy', { members, parties, raidGroups, settings });
assert(imgs.length === 2, `exactly 2 images returned (got ${imgs.length})`);
assert(imgs[0].field === 'main' && imgs[1].field === 'sub', 'order is Main then Sub');
assert(imgs[0].title === 'Main Field' && imgs[1].title === 'Sub Field', 'titles are Main Field / Sub Field');

for (const img of imgs) {
  const { width, height } = pngSize(img.buffer);
  const file = path.join(OUT_DIR, img.filename);
  fs.writeFileSync(file, img.buffer);
  assert(width === WIDTH, `${img.filename}: width === 1920 (got ${width})`);
  assert(img.buffer.length < MAX_BYTES, `${img.filename}: bytes < 8MB (got ${img.buffer.length})`);
  console.log(`      -> ${file}  (${width}x${height}, ${(img.buffer.length / 1024).toFixed(1)} KB)`);
}

console.log('\n[2] layout math — "max 2 rows" is a CAP, small n stays a single row');
const MARGIN = 20, CARD_GAP = 16, IDEAL_CARD_W = 360, MIN_CARD_W = 180;
const usable = WIDTH - MARGIN * 2;
const colsPerRow = Math.max(1, Math.floor((usable + CARD_GAP) / (IDEAL_CARD_W + CARD_GAP)));
console.log(`      colsPerRow (natural cards per row) = ${colsPerRow}`);
assert(colsPerRow === 5, `colsPerRow == 5 at IDEAL 360 (got ${colsPerRow})`);

// [rowsExpected, colsExpected, cardW-is-ideal?] per n.
const cases = [
  { n: 1, rows: 1, cols: 1, ideal: true },
  { n: 2, rows: 1, cols: 2, ideal: true },
  { n: 3, rows: 1, cols: 3, ideal: true },
  { n: 5, rows: 1, cols: 5, ideal: true },
  { n: 9, rows: 2, cols: 5, ideal: true },   // 5 + 4
  { n: 12, rows: 2, cols: 6, ideal: false },  // 6 + 6, shrink-to-fill
];
for (const c of cases) {
  const L = layoutSection(Array.from({ length: c.n }, (_, i) => ({ partyId: `p${i}`, memberIds: ['u7'] })));
  assert(L.rows.length === c.rows, `n=${c.n}: rows == ${c.rows} (got ${L.rows.length})`);
  assert(L.cols === c.cols, `n=${c.n}: cols == ${c.cols} (got ${L.cols})`);
  assert(L.rows.length <= MAX_ROWS, `n=${c.n}: rows <= 2 cap`);
  if (c.ideal) {
    assert(Math.abs(L.cardW - IDEAL_CARD_W) < 0.5, `n=${c.n}: cardW == IDEAL 360 (got ${L.cardW.toFixed(1)})`);
  } else {
    const expectW = (usable - (c.cols - 1) * CARD_GAP) / c.cols;
    assert(Math.abs(L.cardW - expectW) < 0.5, `n=${c.n}: cardW shrinks-to-fill (${L.cardW.toFixed(1)} ≈ ${expectW.toFixed(1)})`);
    assert(L.cardW >= MIN_CARD_W, `n=${c.n}: cardW >= MIN_CARD_W 180`);
  }
}
const sub9 = layoutSection(Array.from({ length: 9 }, (_, i) => ({ partyId: `s${i}`, memberIds: ['u7'] })));
assert(sub9.rows[0].cells.length === 5 && sub9.rows[1].cells.length === 4, 'n=9 grid splits 5 + 4 (unchanged good output)');
const g12 = layoutSection(Array.from({ length: 12 }, (_, i) => ({ partyId: `t${i}`, memberIds: ['u7'] })));
assert(g12.rows[0].cells.length === 6 && g12.rows[1].cells.length === 6, 'n=12 grid splits 6 + 6');

console.log('\n[3] render n=1/2/3/5/9/12 samples → confirm PNG width===1920 + single-row for small n');
for (const n of [1, 2, 3, 5, 9, 12]) {
  const pts = Array.from({ length: n }, (_, i) => party(`d${i}`, 'main', `P${i}`, i, ['u7', 'u1', 'u2']));
  const raids = [{ raidGroupId: 'r', type: 'daddy', field: 'main', name: 'R', partyIds: pts.map(p => p.partyId), position: 1 }];
  const imgsN = buildRaidImages('daddy', { members, parties: pts, raidGroups: raids, settings });
  const main = imgsN[0]; // Main Field carries all n; Sub is empty.
  const { width, height } = pngSize(main.buffer);
  const L = layoutSection(pts);
  fs.writeFileSync(path.join(OUT_DIR, `n${n}-main.png`), main.buffer);
  assert(width === WIDTH, `n=${n}: PNG width === 1920 (got ${width})`);
  console.log(`      n=${n}: ${width}x${height}, ${L.rows.length} row(s), ${L.cols} col(s), cardW ${L.cardW.toFixed(0)}px  -> n${n}-main.png`);
}

console.log('\n[4] empty field renders 1920-wide empty-state, no crash');
const emptyImgs = buildRaidImages('mummy', { members: [], parties: [], raidGroups: [], settings });
assert(emptyImgs.length === 2, `empty roster still returns 2 images (got ${emptyImgs.length})`);
for (const img of emptyImgs) {
  const { width, height } = pngSize(img.buffer);
  assert(width === WIDTH, `empty ${img.title}: width === 1920 (got ${width})`);
  fs.writeFileSync(path.join(OUT_DIR, `empty-${img.field}.png`), img.buffer);
  console.log(`      -> empty ${img.field}: ${width}x${height}`);
}

console.log('\n[5] missing-class party is present in main pool (rose card drawn)');
// Bravo has no Priest → should be flagged missing by computeMissing internally.
const { computeMissing, buildContext } = require('../roster/render');
const gctx = buildContext({ members, settings });
const bravo = parties.find(p => p.partyId === 'daddy-main-2');
assert(computeMissing(bravo, gctx).includes('Priest'), 'Bravo flagged MISSING: Priest (rose treatment)');
assert(!isEmptyParty(bravo), 'Bravo is non-empty');

console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'} — samples in ${OUT_DIR}`);
process.exit(failures === 0 ? 0 : 1);
