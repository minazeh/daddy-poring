// ---------------------------------------------------------------------------
// Guild-roster IMAGE rendering for /guildroster (canvas / @napi-rs/canvas).
//
// ONE IMAGE PER RAID GROUP (Conrad's explicit choice), Main field then Sub,
// plus an "Unassigned Parties" image per field for non-empty unassigned parties.
// Each image is a PNG Buffer the command wraps in an AttachmentBuilder.
//
// Aesthetic mirrors the web app's dark-neon party board: dark indigo page,
// indigo card accents, light text. A party MISSING a required class renders on
// a deep rose-red card (web PartyCard "missing" = from-rose-950 to-red-950).
//
// Class→role + required-class logic is inlined here (web app is a separate repo).
// Defaults MUST match the web app:
//   Knight=tank, Priest=healer, everything else / null = dps.
//   required classes ← settings.requiredClasses (fallback Priest×1).
//   partySize ← settings.partySize (fallback 5).
//
// Fonts are BUNDLED (Railway has no system fonts): Inter (OFL-1.1) from
// @fontsource/inter, registered from node_modules .woff at module load.
//
// NO EMOJI in canvas (they don't render) — role badges are DRAWN: a small
// rounded square with a letter, tank=blue / healer=green / dps=orange.
// ---------------------------------------------------------------------------

const path = require('node:path');
const { createCanvas, GlobalFonts } = require('@napi-rs/canvas');

// ---------------------------------------------------------------------------
// Font registration (idempotent). Inter regular + bold, bundled .woff.
// ---------------------------------------------------------------------------
const FONT_REG = 'Inter';
const FONT_BOLD = 'InterBold';
let fontsRegistered = false;
let fontErr = null;

(function registerFonts() {
  try {
    const base = path.join(
      __dirname, '..', 'node_modules', '@fontsource', 'inter', 'files',
    );
    GlobalFonts.registerFromPath(path.join(base, 'inter-latin-400-normal.woff'), FONT_REG);
    GlobalFonts.registerFromPath(path.join(base, 'inter-latin-700-normal.woff'), FONT_BOLD);
    fontsRegistered = true;
  } catch (err) {
    fontErr = err;
    console.warn('[roster/render] Font registration failed — falling back to system sans:', err?.message || err);
  }
})();

function fReg(size) { return `${size}px ${fontsRegistered ? FONT_REG : 'sans-serif'}`; }
function fBold(size) { return `${size}px ${fontsRegistered ? FONT_BOLD : 'sans-serif'}`; }

// ---------------------------------------------------------------------------
// Class → role logic (web-app parity)
// ---------------------------------------------------------------------------
const DEFAULT_CLASS_ROLES = {
  Knight: 'tank',
  Priest: 'healer',
  Assassin: 'dps',
  Hunter: 'dps',
  Gunslinger: 'dps',
  Blacksmith: 'dps',
  Wizard: 'dps',
  Druid: 'dps',
};

const DEFAULT_REQUIRED_CLASSES = [{ className: 'Priest', min: 1 }];
const DEFAULT_PARTY_SIZE = 5;

// Drawn role badge colors (NOT emoji).
const ROLE_BADGE = {
  tank:   { bg: '#3b82f6', letter: 'T' }, // blue
  healer: { bg: '#22c55e', letter: 'H' }, // green
  dps:    { bg: '#f97316', letter: 'D' }, // orange
};

// Palette (dark neon, web-app parity).
const COL = {
  page:        '#10101f',
  headerBand:  '#1e1b4b', // indigo-950
  accent:      '#6366f1', // indigo-500
  cardBg:      '#161634',
  cardBorder:  '#312e81', // indigo-900
  missingBg:   '#4c0519', // rose-950
  missingBdr:  '#ef4444', // red-500
  text:        '#f1f5f9',
  muted:       '#94a3b8',
  warn:        '#fca5a5', // red-300 for the MISSING flag
};

const MAX_IMAGES_PER_MESSAGE = 10;
const MAX_BYTES = 8 * 1024 * 1024; // 8MB Discord attachment cap

// Layout constants.
const MARGIN = 20;
const HEADER_H = 60;
const CARD_W = 330;
const CARD_GAP = 16;
const CARD_PAD = 14;
const TITLE_H = 26;
const MISSING_H = 20;
const ROW_H = 24;
const BADGE = 16;

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests / simulation)
// ---------------------------------------------------------------------------
function isEmptyParty(p) {
  return !p || !Array.isArray(p.memberIds) || p.memberIds.length === 0;
}

function classToRole(className, classRoles) {
  if (!className) return 'dps';
  const map = classRoles || DEFAULT_CLASS_ROLES;
  return map[className] || 'dps';
}

function computeMissing(party, ctx) {
  const counts = {};
  for (const id of party.memberIds || []) {
    const m = ctx.memberMap.get(id);
    const cls = m && m.className;
    if (cls) counts[cls] = (counts[cls] || 0) + 1;
  }
  const missing = [];
  for (const req of ctx.requiredClasses) {
    if ((counts[req.className] || 0) < req.min) missing.push(req.className);
  }
  return missing;
}

function memberRow(userId, ctx) {
  const m = ctx.memberMap.get(userId);
  if (!m) return { role: 'dps', label: 'Unknown', sub: String(userId) };
  return {
    role: classToRole(m.className, ctx.classRoles),
    label: m.displayName || m.username || String(userId),
    sub: m.className || 'no class',
  };
}

function buildContext(data) {
  const { members = [], settings = null } = data;
  return {
    memberMap: new Map(members.map(m => [m.userId, m])),
    classRoles: (settings && settings.classRoles) || DEFAULT_CLASS_ROLES,
    requiredClasses:
      settings && Array.isArray(settings.requiredClasses) && settings.requiredClasses.length
        ? settings.requiredClasses
        : DEFAULT_REQUIRED_CLASSES,
    partySize: (settings && settings.partySize) || DEFAULT_PARTY_SIZE,
  };
}

// ---------------------------------------------------------------------------
// Canvas drawing helpers
// ---------------------------------------------------------------------------
function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

function truncToWidth(ctx, text, maxW) {
  if (ctx.measureText(text).width <= maxW) return text;
  let s = text;
  while (s.length > 1 && ctx.measureText(`${s}…`).width > maxW) {
    s = s.slice(0, -1);
  }
  return `${s}…`;
}

function slug(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'group';
}

// Height of one party card.
function cardHeight(party) {
  const memberCount = (party.memberIds || []).length;
  return CARD_PAD + TITLE_H + MISSING_H + CARD_PAD + memberCount * ROW_H;
}

// Responsive column count for N cards (1–3).
function colsFor(n) {
  if (n <= 1) return 1;
  if (n === 2) return 2;
  return 3;
}

function paintPage(ctx, w, h) {
  ctx.fillStyle = COL.page;
  ctx.fillRect(0, 0, w, h);
}

function drawHeader(ctx, w, title) {
  ctx.fillStyle = COL.headerBand;
  ctx.fillRect(0, 0, w, HEADER_H);
  ctx.fillStyle = COL.accent; // indigo accent underline
  ctx.fillRect(0, HEADER_H - 3, w, 3);
  ctx.fillStyle = COL.text;
  ctx.font = fBold(20);
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.fillText(truncToWidth(ctx, title, w - MARGIN * 2), MARGIN, HEADER_H / 2);
  ctx.textBaseline = 'top';
}

// Draw a single party card at (x, y) with fixed width CARD_W and given height.
function drawCard(ctx, x, y, h, party, gctx) {
  const missing = computeMissing(party, gctx);
  const isMissing = missing.length > 0;

  roundRect(ctx, x, y, CARD_W, h, 12);
  ctx.fillStyle = isMissing ? COL.missingBg : COL.cardBg;
  ctx.fill();
  ctx.lineWidth = isMissing ? 2 : 1;
  ctx.strokeStyle = isMissing ? COL.missingBdr : COL.cardBorder;
  ctx.stroke();

  const innerX = x + CARD_PAD;
  const innerW = CARD_W - CARD_PAD * 2;
  let cy = y + CARD_PAD;

  // Title: party name + fill.
  const count = (party.memberIds || []).length;
  ctx.fillStyle = COL.text;
  ctx.font = fBold(16);
  ctx.textBaseline = 'top';
  ctx.textAlign = 'left';
  ctx.fillText(
    truncToWidth(ctx, `${party.name || party.partyId}  (${count}/${gctx.partySize})`, innerW),
    innerX, cy,
  );
  cy += TITLE_H;

  // Missing flag (or OK note).
  ctx.font = fBold(12);
  if (isMissing) {
    ctx.fillStyle = COL.warn;
    ctx.fillText(truncToWidth(ctx, `MISSING: ${missing.join(', ')}`, innerW), innerX, cy);
  } else {
    ctx.fillStyle = COL.muted;
    ctx.fillText('Required classes met', innerX, cy);
  }
  cy += MISSING_H + 4;

  // Member rows.
  for (const id of party.memberIds || []) {
    const row = memberRow(id, gctx);
    const badge = ROLE_BADGE[row.role] || ROLE_BADGE.dps;

    // Drawn role badge.
    roundRect(ctx, innerX, cy + 2, BADGE, BADGE, 4);
    ctx.fillStyle = badge.bg;
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.font = fBold(11);
    ctx.textAlign = 'center';
    ctx.fillText(badge.letter, innerX + BADGE / 2, cy + 4);
    ctx.textAlign = 'left';

    // Name + class.
    const textX = innerX + BADGE + 8;
    const textMaxW = innerW - BADGE - 8;
    ctx.font = fReg(13);
    ctx.fillStyle = COL.text;
    ctx.fillText(truncToWidth(ctx, `${row.label}  (${row.sub})`, textMaxW), textX, cy + 3);

    cy += ROW_H;
  }
}

// ---------------------------------------------------------------------------
// Render one raid (or Unassigned group) image → PNG Buffer.
// `parties` = non-empty parties (already filtered/ordered).
// ---------------------------------------------------------------------------
function renderGroupImage(title, parties, gctx) {
  // Empty (all parties empty) → still emit a small image with a note.
  if (!parties.length) {
    const w = MARGIN * 2 + CARD_W;
    const h = HEADER_H + MARGIN + 60;
    const canvas = createCanvas(w, h);
    const ctx = canvas.getContext('2d');
    paintPage(ctx, w, h);
    drawHeader(ctx, w, title);
    ctx.fillStyle = COL.muted;
    ctx.font = fReg(15);
    ctx.textBaseline = 'top';
    ctx.textAlign = 'left';
    ctx.fillText('(all parties empty)', MARGIN, HEADER_H + MARGIN + 8);
    return canvas.toBuffer('image/png');
  }

  const cols = colsFor(parties.length);
  const heights = parties.map(cardHeight);

  // Group into rows; each row's height = max card height in the row.
  const rows = [];
  for (let i = 0; i < parties.length; i += cols) {
    const slice = parties.slice(i, i + cols).map((p, j) => ({ p, h: heights[i + j] }));
    rows.push({ cells: slice, h: Math.max(...slice.map(c => c.h)) });
  }

  const width = MARGIN * 2 + cols * CARD_W + (cols - 1) * CARD_GAP;
  const gridH = rows.reduce((sum, r) => sum + r.h, 0) + (rows.length - 1) * CARD_GAP;
  const height = HEADER_H + MARGIN + gridH + MARGIN;

  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  paintPage(ctx, width, height);
  drawHeader(ctx, width, title);

  let y = HEADER_H + MARGIN;
  for (const row of rows) {
    let x = MARGIN;
    for (const cell of row.cells) {
      drawCard(ctx, x, y, cell.h, cell.p, gctx);
      x += CARD_W + CARD_GAP;
    }
    y += row.h + CARD_GAP;
  }

  return canvas.toBuffer('image/png');
}

// ---------------------------------------------------------------------------
// Build all images for a guild. Returns an array of:
//   { filename, title, buffer }
// Empty state (nothing to show) returns [] — the command sends a text reply.
// ---------------------------------------------------------------------------
function buildGuildImages(guild, data) {
  const { parties = [], raidGroups = [] } = data;
  const gctx = buildContext(data);
  const partyMap = new Map(parties.map(p => [p.partyId, p]));
  const guildLabel = guild === 'mummy' ? 'Mummy' : 'Daddy';

  const images = [];

  for (const field of ['main', 'sub']) {
    const fieldLabel = field === 'main' ? 'Main Field' : 'Sub Field';
    const raids = raidGroups.filter(r => r.field === field); // pre-sorted by position
    const assigned = new Set();

    for (const raid of raids) {
      const ids = raid.partyIds || [];
      ids.forEach(id => assigned.add(id));
      const resolved = ids.map(id => partyMap.get(id)).filter(Boolean);
      const nonEmpty = resolved.filter(p => !isEmptyParty(p));
      const title = `${guildLabel} · ${fieldLabel} · ${raid.name}`;
      images.push({
        filename: `raid-${slug(`${field}-${raid.name}`)}.png`,
        title,
        buffer: renderGroupImage(title, nonEmpty, gctx),
      });
    }

    // Unassigned (non-empty) parties for this field.
    const unassigned = parties
      .filter(p => p.field === field && !assigned.has(p.partyId) && !isEmptyParty(p))
      .sort((a, b) => (a.position || 0) - (b.position || 0));

    if (unassigned.length) {
      const title = `${guildLabel} · ${fieldLabel} · Unassigned Parties`;
      images.push({
        filename: `raid-${slug(`${field}-unassigned`)}.png`,
        title,
        buffer: renderGroupImage(title, unassigned, gctx),
      });
    }
  }

  return images;
}

// Split images into chunks of ≤10 (Discord attachments-per-message cap).
function chunkImages(images, size = MAX_IMAGES_PER_MESSAGE) {
  const chunks = [];
  for (let i = 0; i < images.length; i += size) {
    chunks.push(images.slice(i, i + size));
  }
  return chunks;
}

module.exports = {
  buildGuildImages,
  chunkImages,
  renderGroupImage,
  buildContext,
  // pure helpers (tests / sim)
  classToRole,
  computeMissing,
  memberRow,
  isEmptyParty,
  fontsRegistered: () => fontsRegistered,
  fontError: () => fontErr,
  DEFAULT_CLASS_ROLES,
  DEFAULT_REQUIRED_CLASSES,
  DEFAULT_PARTY_SIZE,
  MAX_IMAGES_PER_MESSAGE,
  MAX_BYTES,
};
