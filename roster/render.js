// ---------------------------------------------------------------------------
// Guild-roster IMAGE rendering for /guildroster (canvas / @napi-rs/canvas).
//
// TWO IMAGES PER RUN (Conrad's confirmed spec): one for Main Field, one for Sub
// Field, in that order. Each field image POOLS every non-empty party in that
// field into ONE FLAT GRID — no raid-group separators/headers inside the image.
// Ordering within a field: raids in `position` order, each raid's parties in its
// `partyIds` order, then that field's unassigned parties by `position`. Only
// NON-empty parties are drawn.
//
// LAYOUT: landscape, width EXACTLY 1920px (hard constraint), MAX 2 ROWS.
// Column count = ceil(nParties / 2) so parties fill at most 2 rows with as many
// columns as needed. Card width fills the 1920 width across that column count
// (respecting MARGIN + CARD_GAP). Height is content-driven (header band + up to
// 2 row heights + margins), targeting roughly 1080 without forcing/distorting.
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
  titleBand:   '#312e81', // indigo-900 — top guild band, slightly brighter
  headerBand:  '#1e1b4b', // indigo-950 — section bands
  accent:      '#6366f1', // indigo-500
  cardBg:      '#161634',
  cardBorder:  '#312e81', // indigo-900
  missingBg:   '#4c0519', // rose-950
  missingBdr:  '#ef4444', // red-500
  text:        '#f1f5f9',
  muted:       '#94a3b8',
  warn:        '#fca5a5', // red-300 for the MISSING flag
  leader:      '#fbbf24', // amber-400 — raid-leader crown, tag, highlighted name
  leaderRowBg: 'rgba(251,191,36,0.14)', // subtle gold wash behind the leader row
  leaderTagFg: '#1f1300', // dark text sitting on the gold "Leader" tag pill
};

const MAX_BYTES = 8 * 1024 * 1024; // 8MB Discord attachment cap
const MAX_HEIGHT = 12000;          // pathological-height guard (won't trigger on real data)

// Layout constants.
const WIDTH = 1920;                // HARD constraint — every image is exactly this wide.
const MAX_ROWS = 2;                // parties fill at most 2 rows.
const MARGIN = 20;
const SECTION_IMG_HEADER_H = 52;   // per-image header band height.
const EMPTY_NOTE_H = 34;           // height reserved for an "(no parties yet)" note.

// Card metrics. Cards keep a natural IDEAL_CARD_W and left-align; they only
// shrink-to-fill (down to MIN_CARD_W) when there are so many parties that more
// than one full row's worth of columns is needed within the 2-row cap.
const IDEAL_CARD_W = 360;          // natural card width (near the old fixed 330).
const MIN_CARD_W = 180;            // legibility floor (names truncate below this).
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

// Validated set of raid-LEADER userIds. For each raid group carrying a
// `leaderId`, the id is only honored if it's actually among the memberIds of one
// of that raid group's parties (the web app enforces the same rule; this is a
// defensive re-check so a stale leader — member moved/removed since it was set —
// degrades gracefully to no crown). A member sits in at most one party, so a
// leader id maps to exactly one row. Returns a Set<string> of userIds.
function computeLeaderSet(raidGroups, partyMap) {
  const set = new Set();
  for (const rg of raidGroups || []) {
    if (!rg || typeof rg.leaderId !== 'string' || !rg.leaderId) continue;
    for (const pid of rg.partyIds || []) {
      const p = partyMap.get(pid);
      if (p && Array.isArray(p.memberIds) && p.memberIds.includes(rg.leaderId)) {
        set.add(rg.leaderId);
        break;
      }
    }
  }
  return set;
}

const EMPTY_SET = new Set();

// ---------------------------------------------------------------------------
// Canvas drawing helpers
// ---------------------------------------------------------------------------
// Fill a filled N-point star centered at (cx, cy) — the drawn "crown" marker for
// a raid leader (canvas can't render emoji/glyphs, so it's a real path). Height
// spans 2*outerR, so keep outerR small enough to fit inside a member ROW_H.
function drawStar(ctx, cx, cy, spikes, outerR, innerR, color) {
  let rot = -Math.PI / 2;
  const step = Math.PI / spikes;
  ctx.beginPath();
  for (let i = 0; i < spikes; i++) {
    ctx.lineTo(cx + Math.cos(rot) * outerR, cy + Math.sin(rot) * outerR);
    rot += step;
    ctx.lineTo(cx + Math.cos(rot) * innerR, cy + Math.sin(rot) * innerR);
    rot += step;
  }
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
}

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

// Height of one party card. Width-independent (member count drives height).
function cardHeight(party) {
  const memberCount = (party.memberIds || []).length;
  return CARD_PAD + TITLE_H + MISSING_H + CARD_PAD + memberCount * ROW_H;
}

function paintPage(ctx, w, h) {
  ctx.fillStyle = COL.page;
  ctx.fillRect(0, 0, w, h);
}

// A full-width header band at (y) of height (h) with title text.
function drawBand(ctx, y, w, h, title, fontSize, bandColor) {
  ctx.fillStyle = bandColor;
  ctx.fillRect(0, y, w, h);
  ctx.fillStyle = COL.accent; // indigo accent underline
  ctx.fillRect(0, y + h - 3, w, 3);
  ctx.fillStyle = COL.text;
  ctx.font = fBold(fontSize);
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.fillText(truncToWidth(ctx, title, w - MARGIN * 2), MARGIN, y + Math.round(h / 2));
  ctx.textBaseline = 'top';
}

// Draw a single party card at (x, y) with EXPLICIT width `w` and given height `h`.
function drawCard(ctx, x, y, w, h, party, gctx) {
  const missing = computeMissing(party, gctx);
  const isMissing = missing.length > 0;

  roundRect(ctx, x, y, w, h, 12);
  ctx.fillStyle = isMissing ? COL.missingBg : COL.cardBg;
  ctx.fill();
  ctx.lineWidth = isMissing ? 2 : 1;
  ctx.strokeStyle = isMissing ? COL.missingBdr : COL.cardBorder;
  ctx.stroke();

  const innerX = x + CARD_PAD;
  const innerW = w - CARD_PAD * 2;
  let cy = y + CARD_PAD;

  const leaderSet = gctx.leaderSet || EMPTY_SET;
  // Does this party contain the (validated) leader of its raid group?
  const partyHasLeader = (party.memberIds || []).some((id) => leaderSet.has(id));

  // Title: party name + fill, plus a gold "Leader" tag pill when this card holds
  // the raid leader. The pill is drawn AFTER the (truncated) title so the title
  // never overruns it.
  const count = (party.memberIds || []).length;
  const titleStr = `${party.name || party.partyId}  (${count}/${gctx.partySize})`;
  ctx.textBaseline = 'top';
  ctx.textAlign = 'left';

  if (partyHasLeader) {
    const TAG = 'Leader';
    const TAG_PAD_X = 6;
    const TAG_H = 17;
    ctx.font = fBold(11);
    const tagTextW = ctx.measureText(TAG).width;
    const pillW = tagTextW + TAG_PAD_X * 2;
    const gap = 8;
    // Reserve room for the pill; truncate the title to what's left.
    ctx.font = fBold(16);
    const titleMaxW = Math.max(20, innerW - pillW - gap);
    const drawn = truncToWidth(ctx, titleStr, titleMaxW);
    ctx.fillStyle = COL.text;
    ctx.fillText(drawn, innerX, cy);
    // Gold pill immediately after the drawn title.
    const pillX = innerX + ctx.measureText(drawn).width + gap;
    roundRect(ctx, pillX, cy, pillW, TAG_H, 4);
    ctx.fillStyle = COL.leader;
    ctx.fill();
    ctx.fillStyle = COL.leaderTagFg;
    ctx.font = fBold(11);
    ctx.textBaseline = 'middle';
    ctx.fillText(TAG, pillX + TAG_PAD_X, cy + Math.round(TAG_H / 2) + 1);
    ctx.textBaseline = 'top';
  } else {
    ctx.fillStyle = COL.text;
    ctx.font = fBold(16);
    ctx.fillText(truncToWidth(ctx, titleStr, innerW), innerX, cy);
  }
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
    const isLeader = leaderSet.has(id);

    // Leader row highlight (drawn first, behind everything). Height-neutral.
    if (isLeader) {
      roundRect(ctx, innerX - 4, cy, innerW + 8, ROW_H - 2, 4);
      ctx.fillStyle = COL.leaderRowBg;
      ctx.fill();
    }

    // Drawn role badge (with a gold ring around it for the leader).
    roundRect(ctx, innerX, cy + 2, BADGE, BADGE, 4);
    ctx.fillStyle = badge.bg;
    ctx.fill();
    if (isLeader) {
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = COL.leader;
      roundRect(ctx, innerX - 1, cy + 1, BADGE + 2, BADGE + 2, 5);
      ctx.stroke();
    }
    ctx.fillStyle = '#ffffff';
    ctx.font = fBold(11);
    ctx.textAlign = 'center';
    ctx.fillText(badge.letter, innerX + BADGE / 2, cy + 4);
    ctx.textAlign = 'left';

    // Name + class. Leader rows render the name in gold and reserve room on the
    // right for a crown star marker.
    const textX = innerX + BADGE + 8;
    const textMaxW = innerW - BADGE - 8 - (isLeader ? 16 : 0);
    ctx.font = fReg(13);
    ctx.fillStyle = isLeader ? COL.leader : COL.text;
    ctx.fillText(truncToWidth(ctx, `${row.label}  (${row.sub})`, textMaxW), textX, cy + 3);

    // Crown marker (gold star) at the right edge of the leader's row.
    if (isLeader) {
      drawStar(ctx, innerX + innerW - 7, cy + Math.round(ROW_H / 2) - 1, 5, 6, 2.6, COL.leader);
    }

    cy += ROW_H;
  }
}

// ---------------------------------------------------------------------------
// Flat-field layout — pools ALL of a field's non-empty parties into a single
// grid. "Max 2 rows" is a CAP, not a target: small counts stay a SINGLE row of
// natural-width (IDEAL_CARD_W) cards, LEFT-ALIGNED, wrapping to a 2nd row only
// when they exceed one row's worth of ideal columns. Only when >colsPerRow
// columns are forced (many parties) do cards shrink-to-fill down to MIN_CARD_W.
//   { rows:[{cells:[{p,h}], h}], gridH, cardW, cols, isEmpty }
// The measure pass and the draw pass both consume this so they agree.
// ---------------------------------------------------------------------------
function layoutSection(parties) {
  if (!parties.length) {
    return { rows: [], gridH: EMPTY_NOTE_H, cardW: WIDTH - MARGIN * 2, cols: 0, isEmpty: true };
  }

  const n = parties.length;
  const usable = WIDTH - MARGIN * 2;
  // How many natural-width cards fit in one row.
  const colsPerRow = Math.max(1, Math.floor((usable + CARD_GAP) / (IDEAL_CARD_W + CARD_GAP)));
  const rowCount = n <= colsPerRow ? 1 : MAX_ROWS; // single row until it overflows, capped at 2.
  const cols = Math.ceil(n / rowCount);
  // Keep the natural width (left-aligned, leftover space is fine) until we need
  // more columns than fit at IDEAL width — then shrink-to-fill within 1920.
  const cardW = cols <= colsPerRow
    ? IDEAL_CARD_W
    : Math.max(MIN_CARD_W, (usable - (cols - 1) * CARD_GAP) / cols);

  const heights = parties.map(cardHeight);
  const rows = [];
  for (let i = 0; i < n; i += cols) {
    const slice = parties.slice(i, i + cols).map((p, j) => ({ p, h: heights[i + j] }));
    rows.push({ cells: slice, h: Math.max(...slice.map(c => c.h)) });
  }
  const gridH = rows.reduce((sum, r) => sum + r.h, 0) + (rows.length - 1) * CARD_GAP;
  return { rows, gridH, cardW, cols, isEmpty: false };
}

// Filename-safe slug from a title.
function slug(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'group';
}

// ---------------------------------------------------------------------------
// Render ONE field (pooled flat grid) to a PNG Buffer at WIDTH × content-height.
// `layout` comes from layoutSection(); `bandTitle` is drawn in the header band.
// Empty field → a short WIDTH-wide empty-state image (never crashes).
// ---------------------------------------------------------------------------
function renderSectionImage(bandTitle, layout, gctx) {
  const gridTop = SECTION_IMG_HEADER_H + MARGIN;
  const bodyH = layout.isEmpty ? EMPTY_NOTE_H : layout.gridH;
  const height = Math.min(MAX_HEIGHT, gridTop + bodyH + MARGIN);

  const canvas = createCanvas(WIDTH, height);
  const ctx = canvas.getContext('2d');
  paintPage(ctx, WIDTH, height);
  drawBand(ctx, 0, WIDTH, SECTION_IMG_HEADER_H, bandTitle, 22, COL.headerBand);

  let y = gridTop;
  if (layout.isEmpty) {
    ctx.fillStyle = COL.muted;
    ctx.font = fReg(15);
    ctx.textBaseline = 'top';
    ctx.textAlign = 'left';
    ctx.fillText('(no parties yet)', MARGIN, y + 4);
  } else {
    for (let i = 0; i < layout.rows.length; i++) {
      const row = layout.rows[i];
      let x = MARGIN;
      for (const cell of row.cells) {
        drawCard(ctx, x, y, layout.cardW, cell.h, cell.p, gctx);
        x += layout.cardW + CARD_GAP;
      }
      y += row.h;
      if (i < layout.rows.length - 1) y += CARD_GAP;
    }
  }

  let buffer = canvas.toBuffer('image/png');

  // 8MB attachment guard. A 1920-wide roster is very unlikely to exceed this,
  // but if it does, degrade to a WIDTH-wide notice rather than post an oversized
  // (rejected) attachment or crash.
  if (buffer.length > MAX_BYTES) {
    console.warn(`[roster/render] "${bandTitle}" exceeded ${MAX_BYTES} bytes (${buffer.length}) — degrading to notice.`);
    const nh = gridTop + EMPTY_NOTE_H + MARGIN;
    const c2 = createCanvas(WIDTH, nh);
    const x2 = c2.getContext('2d');
    paintPage(x2, WIDTH, nh);
    drawBand(x2, 0, WIDTH, SECTION_IMG_HEADER_H, bandTitle, 22, COL.headerBand);
    x2.fillStyle = COL.muted;
    x2.font = fReg(15);
    x2.textBaseline = 'top';
    x2.textAlign = 'left';
    x2.fillText('(too many parties to render in one image)', MARGIN, gridTop + 4);
    buffer = c2.toBuffer('image/png');
  }

  return buffer;
}

// ---------------------------------------------------------------------------
// Build EXACTLY TWO images for a guild: [Main Field, Sub Field] in that order.
// Each field pools every non-empty party into ONE flat grid:
//   raids by position → each raid's parties in partyIds order → field unassigned
//   parties by position. No raid-group headers inside the image.
// Returns [{ field, title, filename, buffer }, { field, title, filename, buffer }].
// Always length 2 (empty fields render an empty-state image).
// ---------------------------------------------------------------------------
function buildRaidImages(guild, data) {
  const gctx = buildContext(data);
  const { parties = [], raidGroups = [] } = data;
  const partyMap = new Map(parties.map(p => [p.partyId, p]));
  // Validated raid-leader userIds (leader must be a member of one of its raid's
  // parties). Global across the guild — a userId sits in at most one party, so a
  // leader maps to exactly one member row / one party card.
  gctx.leaderSet = computeLeaderSet(raidGroups, partyMap);
  const guildLabel = guild === 'mummy' ? 'Mummy' : 'Daddy';
  const out = [];

  for (const field of ['main', 'sub']) {
    const fieldLabel = field === 'main' ? 'Main Field' : 'Sub Field';
    const raids = raidGroups.filter(r => r.field === field); // pre-sorted by position
    const assigned = new Set();
    const pooled = [];

    // Raid parties first, in raid position order, each raid in partyIds order.
    for (const raid of raids) {
      for (const id of raid.partyIds || []) {
        assigned.add(id);
        const p = partyMap.get(id);
        if (p && !isEmptyParty(p)) pooled.push(p);
      }
    }

    // Then this field's unassigned non-empty parties, by position.
    const unassigned = parties
      .filter(p => p.field === field && !assigned.has(p.partyId) && !isEmptyParty(p))
      .sort((a, b) => (a.position || 0) - (b.position || 0));
    pooled.push(...unassigned);

    const layout = layoutSection(pooled);
    out.push({
      field,
      title: fieldLabel,
      filename: `roster-${guild}-${field}.png`,
      buffer: renderSectionImage(`${guildLabel} · ${fieldLabel}`, layout, gctx),
    });
  }

  return out;
}

module.exports = {
  buildRaidImages,
  renderSectionImage,
  layoutSection,
  buildContext,
  // pure helpers (tests / sim)
  classToRole,
  computeMissing,
  computeLeaderSet,
  memberRow,
  isEmptyParty,
  cardHeight,
  fontsRegistered: () => fontsRegistered,
  fontError: () => fontErr,
  DEFAULT_CLASS_ROLES,
  DEFAULT_REQUIRED_CLASSES,
  DEFAULT_PARTY_SIZE,
  MAX_BYTES,
  WIDTH,
  MAX_ROWS,
};
