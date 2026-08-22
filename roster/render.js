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
//   Knight/Paladin=tank, Priest=healer, everything else / null = dps.
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
  Paladin: 'tank',
  Priest: 'healer',
  Assassin: 'dps',
  Hunter: 'dps',
  Gunslinger: 'dps',
  Blacksmith: 'dps',
  Wizard: 'dps',
  Druid: 'dps',
  Monk: 'dps',
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
  raidLabel:   '#c7d2fe', // indigo-200 — the raid "eyebrow" on a POOLED card.
                          // Deliberately light enough to stay readable on BOTH
                          // the indigo card and the deep-rose "missing" card.
};

const MAX_BYTES = 8 * 1024 * 1024; // 8MB Discord attachment cap
const MAX_HEIGHT = 12000;          // pathological-height guard (won't trigger on real data)

// Layout constants.
const WIDTH = 1920;                // HARD constraint — every image is exactly this wide.
const MAX_ROWS = 2;                // DEFAULT row cap (/guildroster). Per-call overridable.
const MAX_POOL_ROWS = 12;          // upper bound when a row count is derived (see fitRows).
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
// Extra card height reserved for the raid "eyebrow" line drawn above the party
// title when cards from DIFFERENT raids are pooled into one image (see
// buildPolarityImages). Zero for /guildroster, which pools a single field.
const RAID_LABEL_H = 16;

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests / simulation)
// ---------------------------------------------------------------------------
function isEmptyParty(p) {
  return !p || !Array.isArray(p.memberIds) || p.memberIds.length === 0;
}

function classToRole(className, classRoles) {
  if (!className) return 'dps';
  const map = classRoles || DEFAULT_CLASS_ROLES;
  // A class the settings doc predates (e.g. Paladin/Monk on a settings doc last
  // saved when there were only 8 classes) falls back to the DEFAULT map rather
  // than a blanket 'dps' — otherwise a new Tank class silently renders as DPS
  // until Settings is re-saved in the web app. No-op for classes the doc has.
  return map[className] || DEFAULT_CLASS_ROLES[className] || 'dps';
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

  // Raid "eyebrow". Only when gctx carries a raidLabels map — i.e. this image
  // pools cards from MORE than one raid, so "Party 1" alone is ambiguous (every
  // raid has its own Party 1). The space is reserved for EVERY card in such an
  // image (even one whose label is missing) so all cards stay the same height,
  // matching the RAID_LABEL_H that layoutSection() measured with.
  if (gctx.raidLabels) {
    const label = gctx.raidLabels.get(party.partyId);
    if (label) {
      ctx.font = fBold(11);
      ctx.fillStyle = COL.raidLabel;
      ctx.textBaseline = 'top';
      ctx.textAlign = 'left';
      ctx.fillText(truncToWidth(ctx, String(label).toUpperCase(), innerW), innerX, cy);
    }
    cy += RAID_LABEL_H;
  }

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
// Flat layout — pools ALL of the given non-empty parties into a single grid.
// The row cap is a CAP, not a target: small counts stay a SINGLE row of
// natural-width (IDEAL_CARD_W) cards, LEFT-ALIGNED, wrapping only when they
// exceed one row's worth of ideal columns. Only when >colsPerRow columns are
// forced (many parties) do cards shrink-to-fill down to MIN_CARD_W.
//   { rows:[{cells:[{p,h}], h}], gridH, cardW, cols, isEmpty }
// The measure pass and the draw pass both consume this so they agree.
//
// `maxRows` DEFAULTS TO MAX_ROWS (2) so /guildroster's output is unchanged; the
// pooled polarity images pass a derived, larger cap (see fitRows). `extraCardH`
// is added to every card's measured height — used to reserve RAID_LABEL_H for
// the raid eyebrow when cards from multiple raids share one image.
// ---------------------------------------------------------------------------
// Largest column count whose shrink-to-fill card width still clears the
// MIN_CARD_W legibility floor inside WIDTH. Derived, not hardcoded, so it tracks
// any future change to WIDTH / MARGIN / CARD_GAP / MIN_CARD_W.
//   (1880 + 16) / (180 + 16) = 9.67 → 9 columns.
function maxLegibleCols() {
  const usable = WIDTH - MARGIN * 2;
  return Math.max(1, Math.floor((usable + CARD_GAP) / (MIN_CARD_W + CARD_GAP)));
}

// Smallest row count that keeps `n` cards above MIN_CARD_W — i.e. the flattest
// grid that is still readable. Used by the POOLED polarity images so the layout
// re-derives itself if Conrad changes partySize or the raid structure, instead
// of a hardcoded row count. Capped at MAX_POOL_ROWS as a sanity bound.
function fitRows(n, cap = MAX_POOL_ROWS) {
  if (!n || n < 1) return 1;
  const rows = Math.ceil(n / maxLegibleCols());
  return Math.min(Math.max(1, rows), Math.max(1, cap));
}

function layoutSection(parties, maxRows = MAX_ROWS, extraCardH = 0) {
  if (!parties.length) {
    return { rows: [], gridH: EMPTY_NOTE_H, cardW: WIDTH - MARGIN * 2, cols: 0, isEmpty: true };
  }

  const n = parties.length;
  const usable = WIDTH - MARGIN * 2;
  const rowCap = Math.max(1, Math.floor(maxRows) || 1);
  // How many natural-width cards fit in one row.
  const colsPerRow = Math.max(1, Math.floor((usable + CARD_GAP) / (IDEAL_CARD_W + CARD_GAP)));
  const rowCount = n <= colsPerRow ? 1 : rowCap; // single row until it overflows, then capped.
  const cols = Math.ceil(n / rowCount);
  // Keep the natural width (left-aligned, leftover space is fine) until we need
  // more columns than fit at IDEAL width — then shrink-to-fill within 1920.
  const cardW = cols <= colsPerRow
    ? IDEAL_CARD_W
    : Math.max(MIN_CARD_W, (usable - (cols - 1) * CARD_GAP) / cols);

  const heights = parties.map(p => cardHeight(p) + extraCardH);
  const rows = [];
  for (let i = 0; i < n; i += cols) {
    const slice = parties.slice(i, i + cols).map((p, j) => ({ p, h: heights[i + j] }));
    rows.push({ cells: slice, h: Math.max(...slice.map(c => c.h)) });
  }
  const gridH = rows.reduce((sum, r) => sum + r.h, 0) + (rows.length - 1) * CARD_GAP;
  return { rows, gridH, cardW, cols, isEmpty: false };
}

// A WIDTH-wide single-line notice image: the page, the header band, and one
// muted line. Used as the graceful degrade when a rendered image blows past the
// MAX_BYTES attachment cap — posting a notice beats posting an attachment
// Discord will reject. Extracted so every renderer degrades identically.
function renderNoticeImage(bandTitle, note) {
  const top = SECTION_IMG_HEADER_H + MARGIN;
  const nh = top + EMPTY_NOTE_H + MARGIN;
  const canvas = createCanvas(WIDTH, nh);
  const ctx = canvas.getContext('2d');
  paintPage(ctx, WIDTH, nh);
  drawBand(ctx, 0, WIDTH, SECTION_IMG_HEADER_H, bandTitle, 22, COL.headerBand);
  ctx.fillStyle = COL.muted;
  ctx.font = fReg(15);
  ctx.textBaseline = 'top';
  ctx.textAlign = 'left';
  ctx.fillText(note, MARGIN, top + 4);
  return canvas.toBuffer('image/png');
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
    buffer = renderNoticeImage(bandTitle, '(too many parties to render in one image)');
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

// ---------------------------------------------------------------------------
// POLARITY RAIDS — EXACTLY TWO images per run, mirroring /guildroster's two
// field images: [Main Raids, Normal Raids] in that order. This is the guild's
// second, independent raid layout (web-owned `polarityRaids` /
// `polarityParties`; nothing to do with the GvG main/sub fields).
//
// Structure per guild: 2 main raids x 5 parties + 4 normal raids x 8 parties.
// Each image POOLS every non-empty party of that KIND into ONE flat grid, in
// raid position order, each raid's parties in slot order.
//
// ROW COUNT IS DERIVED, NOT HARDCODED. layoutSection()'s row cap is a per-call
// parameter now; fitRows() picks the flattest grid whose card width still
// clears MIN_CARD_W, so the layout survives a change to partySize or to the
// raid structure. On today's data: 10 main parties → 2 rows x 5 cols at the
// natural 360px; 32 normal parties → 4 rows x 8 cols at ~221px. Both fit the
// hard 1920 width — the picture grows TALLER, not wider.
//
// RAID ATTRIBUTION: party names repeat across raids (every raid has its own
// "Party 1".."Party 8"), so a pooled card carries a raid "eyebrow" — the raid
// name in small indigo caps directly above the party title, via gctx.raidLabels
// + the RAID_LABEL_H that layoutSection() reserves. /guildroster sets no
// raidLabels, so its cards are byte-identical to before.
//
// Visual language is otherwise IDENTICAL to /guildroster — same palette, same
// card, same drawn role badges, same rose-red "missing required class" card,
// same gold crown/tag/row-wash for a raid leader — because it reuses drawCard(),
// layoutSection(), renderSectionImage() and computeLeaderSet() verbatim.
//
// EMPTY RAIDS: a raid with no non-empty party contributes nothing to its pool
// (no wall of blank cards for a small guild). If a whole KIND ends up empty it
// still renders its empty-state image, so a run is always 2 images — same rule
// /guildroster uses for an empty field. Only when the ENTIRE board is empty do
// we return [], preserving the command's "not set up yet" text reply.
//
// Returns [{ kind, title, filename, buffer, raidCount, partyCount, headcount }].
// ---------------------------------------------------------------------------
function buildPolarityImages(guild, data) {
  const { polarityRaids = [], polarityParties = [] } = data;
  const gctx = buildContext(data);
  const partyMap = new Map(polarityParties.map(p => [p.partyId, p]));

  // Parties grouped by their raid, in slot order.
  const byRaid = new Map();
  for (const p of polarityParties) {
    const list = byRaid.get(p.raidId);
    if (list) list.push(p);
    else byRaid.set(p.raidId, [p]);
  }
  for (const list of byRaid.values()) {
    list.sort((a, b) => (a.position || 0) - (b.position || 0));
  }

  // computeLeaderSet() takes raid groups shaped { leaderId, partyIds } — a
  // polarity party points UP at its raid instead, so derive the same shape.
  const shimmed = polarityRaids.map(r => ({
    leaderId: r.leaderId,
    partyIds: (byRaid.get(r.raidId) || []).map(p => p.partyId),
  }));
  gctx.leaderSet = computeLeaderSet(shimmed, partyMap);

  const guildLabel = guild === 'mummy' ? 'Mummy' : 'Daddy';
  const ordered = polarityRaids
    .slice()
    .sort((a, b) => (a.position || 0) - (b.position || 0));

  // Pool by KIND. A wholly-empty raid contributes nothing at all, and each
  // pooled party remembers which raid it came from for the card eyebrow.
  const pools = {
    main:   { parties: [], raids: 0 },
    normal: { parties: [], raids: 0 },
  };
  const raidLabels = new Map();

  for (const raid of ordered) {
    const kind = raid.kind === 'normal' ? 'normal' : 'main';
    const live = (byRaid.get(raid.raidId) || []).filter(p => !isEmptyParty(p));
    if (!live.length) continue; // skip an untouched raid entirely
    const raidName = raid.name || raid.raidId;
    for (const p of live) raidLabels.set(p.partyId, raidName);
    pools[kind].parties.push(...live);
    pools[kind].raids += 1;
  }

  // Entire board untouched → no images; the command replies with a text notice.
  if (!pools.main.parties.length && !pools.normal.parties.length) return [];

  // Presence of this map is what switches the raid eyebrow on (and what makes
  // RAID_LABEL_H reserved space real). /guildroster never sets it.
  gctx.raidLabels = raidLabels;

  const KINDS = [
    { kind: 'main',   label: 'Main Raids (top power)' },
    { kind: 'normal', label: 'Normal Raids' },
  ];

  return KINDS.map(({ kind, label }) => {
    const pooled = pools[kind].parties;
    const headcount = pooled.reduce((s, p) => s + (p.memberIds || []).length, 0);
    const raidCount = pools[kind].raids;
    const band = pooled.length
      ? `${guildLabel} · ${label} — ${raidCount} raid${raidCount === 1 ? '' : 's'} · ${pooled.length} part${pooled.length === 1 ? 'y' : 'ies'} · ${headcount} member${headcount === 1 ? '' : 's'}`
      : `${guildLabel} · ${label}`;
    const layout = layoutSection(pooled, fitRows(pooled.length), RAID_LABEL_H);

    return {
      kind,
      title: label,
      raidCount,
      partyCount: pooled.length,
      headcount,
      filename: `polarity-${guild}-${kind}.png`,
      buffer: renderSectionImage(band, layout, gctx),
    };
  });
}

// ---------------------------------------------------------------------------
// SIEGE — ONE image per run, with a GROUP-AWARE layout.
//
// The siege layout is a THIRD, independent raid arrangement (web-owned
// `siegeRaids` / `siegeParties`; nothing to do with the GvG main/sub fields or
// the polarity board). Four raids per guild — Alpha, Bravo, Charlie, Delta Flex
// — 8 parties each, and daddy/mummy are two entirely separate sieges.
//
// WHY A NEW LAYOUT FUNCTION. layoutSection() pools parties into one flat grid
// with a UNIFORM column count (cols = ceil(n / rowCount)); it has no concept of
// a group, so a row boundary lands wherever the arithmetic puts it. With four
// FULL raids that coincidentally yields [8,8,8,8] — one raid per row — but the
// moment one raid contributes fewer parties (and empty parties are hidden here,
// see below) the pool stops dividing evenly and rows straddle two raids:
// Alpha 7 / Bravo 8 / Charlie 8 / Delta 6 pools to [8,8,8,5], i.e. row 0 is
// "Alpha + one Bravo card". Conrad's requirement is one raid per row band, so
// the grouping has to be structural rather than arithmetic.
//
// layoutRaidGroups() therefore lays each raid out as its OWN block — a header
// band plus that raid's own row(s) of cards — while keeping ONE card width
// across the whole image (derived from the widest raid) so every card is the
// same size no matter which raid it sits in. layoutSection() is untouched, so
// /guildroster and /polarityraid render exactly as before.
//
// EMPTY PARTIES ARE HIDDEN (Conrad's call), the same rule the other two image
// builders use. A raid with 6 filled parties draws 6 cards and its row is
// visibly shorter than a full raid's — intended. A raid with NO filled parties
// still gets its band, with a short "(no parties yet)" note, so all four raids
// are always accounted for.
//
// The per-raid band carries the raid NAME, its party/member counts and its
// LEADER, which is why siege cards need no raid "eyebrow" (gctx.raidLabels is
// deliberately not set) — the band says it once for the whole row instead of
// repeating it on every card at 221px.
// ---------------------------------------------------------------------------
const SIEGE_BAND_H = 38;     // per-raid header band inside the siege image
const SIEGE_BAND_GAP = 10;   // raid band → its first row of cards
const SIEGE_GROUP_GAP = 18;  // one raid block → the next
const SIEGE_EMPTY_H = 26;    // the "(no parties yet)" line under an empty raid's band

// A per-raid header band: raid name + counts on the left, leader on the right.
// Full-bleed like drawBand() so the four raids read as four distinct strips.
function drawRaidBand(ctx, y, w, h, name, meta, leaderName) {
  ctx.fillStyle = COL.headerBand;
  ctx.fillRect(0, y, w, h);
  ctx.fillStyle = COL.accent;
  ctx.fillRect(0, y + h - 2, w, 2);   // indigo underline
  ctx.fillRect(0, y, 5, h);           // left accent tick

  const mid = y + Math.round(h / 2);
  ctx.textBaseline = 'middle';

  // Right side first — the leader — so the raid name can then be truncated
  // against whatever space is actually left.
  let rightEdge = w - MARGIN;
  if (leaderName) {
    ctx.font = fBold(13);
    const drawn = truncToWidth(ctx, `Leader: ${leaderName}`, Math.round(w * 0.35));
    const textW = ctx.measureText(drawn).width;
    ctx.textAlign = 'left';
    ctx.fillStyle = COL.leader;
    ctx.fillText(drawn, rightEdge - textW, mid);
    // Crown star just before the label.
    drawStar(ctx, rightEdge - textW - 12, mid, 5, 6, 2.6, COL.leader);
    rightEdge -= textW + 26;
  }

  ctx.textAlign = 'left';
  ctx.font = fBold(18);
  const avail = Math.max(40, rightEdge - MARGIN);
  const nameStr = truncToWidth(ctx, name, avail);
  ctx.fillStyle = COL.text;
  ctx.fillText(nameStr, MARGIN, mid);

  if (meta) {
    const metaX = MARGIN + ctx.measureText(nameStr).width + 12;
    ctx.font = fReg(12);
    ctx.fillStyle = COL.muted;
    ctx.fillText(truncToWidth(ctx, meta, Math.max(0, rightEdge - metaX)), metaX, mid);
  }

  ctx.textBaseline = 'top';
  ctx.textAlign = 'left';
}

// ---------------------------------------------------------------------------
// Group-aware layout. `groups` is an ORDERED [{ name, meta, leaderName,
// parties }] — parties already filtered and sorted by the caller. Every group
// gets its own block; a group with more parties than fit in one row wraps
// within its OWN block and never bleeds into the next one.
//   { blocks:[{ group, rows:[{cells:[{p,h}],h}], blockH }], cardW, cols, totalH }
// The measure pass and the draw pass both consume this so they agree.
// ---------------------------------------------------------------------------
function layoutRaidGroups(groups) {
  const usable = WIDTH - MARGIN * 2;
  const colsPerRow = Math.max(1, Math.floor((usable + CARD_GAP) / (IDEAL_CARD_W + CARD_GAP)));

  // ONE card width for the whole image, driven by the WIDEST raid so that no
  // raid wraps before the others do and every card is the same size wherever it
  // sits. Capped at the MIN_CARD_W legibility floor by maxLegibleCols().
  const widest = groups.reduce((m, g) => Math.max(m, g.parties.length), 0);
  const cols = Math.min(Math.max(1, widest), maxLegibleCols());
  const cardW = cols <= colsPerRow
    ? IDEAL_CARD_W
    : Math.max(MIN_CARD_W, (usable - (cols - 1) * CARD_GAP) / cols);

  const blocks = [];
  let totalH = 0;
  for (const g of groups) {
    const rows = [];
    for (let i = 0; i < g.parties.length; i += cols) {
      const cells = g.parties.slice(i, i + cols).map(p => ({ p, h: cardHeight(p) }));
      rows.push({ cells, h: Math.max(...cells.map(c => c.h)) });
    }
    const bodyH = rows.length
      ? rows.reduce((s, r) => s + r.h, 0) + (rows.length - 1) * CARD_GAP
      : SIEGE_EMPTY_H;
    const blockH = SIEGE_BAND_H + SIEGE_BAND_GAP + bodyH;
    blocks.push({ group: g, rows, blockH });
    totalH += blockH;
  }
  if (blocks.length > 1) totalH += (blocks.length - 1) * SIEGE_GROUP_GAP;

  return { blocks, cardW, cols, totalH, isEmpty: blocks.length === 0 };
}

// ---------------------------------------------------------------------------
// Render a grouped layout to a PNG Buffer at WIDTH × content-height: one image
// header band, then one band + row(s) per group. Same page paint, same cards,
// same 8MB degrade path as renderSectionImage().
// ---------------------------------------------------------------------------
function renderGroupedImage(bandTitle, layout, gctx) {
  const top = SECTION_IMG_HEADER_H + MARGIN;
  const bodyH = layout.isEmpty ? EMPTY_NOTE_H : layout.totalH;
  const height = Math.min(MAX_HEIGHT, top + bodyH + MARGIN);

  const canvas = createCanvas(WIDTH, height);
  const ctx = canvas.getContext('2d');
  paintPage(ctx, WIDTH, height);
  drawBand(ctx, 0, WIDTH, SECTION_IMG_HEADER_H, bandTitle, 22, COL.headerBand);

  let y = top;
  if (layout.isEmpty) {
    ctx.fillStyle = COL.muted;
    ctx.font = fReg(15);
    ctx.textBaseline = 'top';
    ctx.textAlign = 'left';
    ctx.fillText('(no raids yet)', MARGIN, y + 4);
  } else {
    for (let b = 0; b < layout.blocks.length; b++) {
      const block = layout.blocks[b];
      const g = block.group;
      drawRaidBand(ctx, y, WIDTH, SIEGE_BAND_H, g.name, g.meta, g.leaderName);
      y += SIEGE_BAND_H + SIEGE_BAND_GAP;

      if (!block.rows.length) {
        ctx.fillStyle = COL.muted;
        ctx.font = fReg(13);
        ctx.textBaseline = 'top';
        ctx.textAlign = 'left';
        ctx.fillText('(no parties yet)', MARGIN, y + 2);
        y += SIEGE_EMPTY_H;
      } else {
        for (let i = 0; i < block.rows.length; i++) {
          const row = block.rows[i];
          let x = MARGIN;
          for (const cell of row.cells) {
            drawCard(ctx, x, y, layout.cardW, cell.h, cell.p, gctx);
            x += layout.cardW + CARD_GAP;
          }
          y += row.h;
          if (i < block.rows.length - 1) y += CARD_GAP;
        }
      }
      if (b < layout.blocks.length - 1) y += SIEGE_GROUP_GAP;
    }
  }

  let buffer = canvas.toBuffer('image/png');
  if (buffer.length > MAX_BYTES) {
    console.warn(`[roster/render] "${bandTitle}" exceeded ${MAX_BYTES} bytes (${buffer.length}) — degrading to notice.`);
    buffer = renderNoticeImage(bandTitle, '(too many parties to render in one image)');
  }
  return buffer;
}

// ---------------------------------------------------------------------------
// Build the ONE siege image for a guild. Exactly one image — never an album.
//
// Order is the raid docs' `position` (Alpha, Bravo, Charlie, Delta Flex); each
// raid's parties are drawn in slot order with the EMPTY ones dropped. Parties
// whose raid doc is missing are not thrown away — they get a trailing block of
// their own so nothing silently vanishes from the picture.
//
// Returns null when the siege has never been set up on the web app (no raid
// docs AND no party docs) so the command can say so in text rather than post a
// picture of nothing. Otherwise:
//   { title, filename, buffer, raidCount, partyCount, headcount,
//     raids:[{ name, leaderName, partyCount, headcount }] }
// ---------------------------------------------------------------------------
function buildSiegeImage(guild, data) {
  const { siegeRaids = [], siegeParties = [] } = data;
  if (!siegeRaids.length && !siegeParties.length) return null;

  const gctx = buildContext(data);
  const partyMap = new Map(siegeParties.map(p => [p.partyId, p]));

  // Parties grouped by their raid, in slot order.
  const byRaid = new Map();
  for (const p of siegeParties) {
    const list = byRaid.get(p.raidId);
    if (list) list.push(p);
    else byRaid.set(p.raidId, [p]);
  }
  for (const list of byRaid.values()) {
    list.sort((a, b) => (a.position || 0) - (b.position || 0));
  }

  // computeLeaderSet() takes raid groups shaped { leaderId, partyIds } — a
  // siege party points UP at its raid (the polarity model), so derive that
  // shape. Same validation: a leaderId that isn't actually in one of its raid's
  // parties is ignored rather than crowning a stale row.
  const shimmed = siegeRaids.map(r => ({
    leaderId: r.leaderId,
    partyIds: (byRaid.get(r.raidId) || []).map(p => p.partyId),
  }));
  gctx.leaderSet = computeLeaderSet(shimmed, partyMap);

  const ordered = siegeRaids.slice().sort((a, b) => (a.position || 0) - (b.position || 0));
  const seen = new Set();
  const groups = [];

  for (const raid of ordered) {
    seen.add(raid.raidId);
    const own = byRaid.get(raid.raidId) || [];
    const live = own.filter(p => !isEmptyParty(p));
    const headcount = live.reduce((s, p) => s + (p.memberIds || []).length, 0);
    // Name a leader on the band only if that userId is actually in one of THIS
    // raid's parties. Checked against `own` rather than the global leaderSet:
    // the set is guild-wide, so a stale leaderId that happens to be another
    // raid's valid leader would otherwise be crowned on the wrong band.
    const leaderId = typeof raid.leaderId === 'string' && raid.leaderId ? raid.leaderId : null;
    const leaderOk = leaderId
      ? own.some(p => (p.memberIds || []).includes(leaderId))
      : false;
    const leader = leaderOk ? gctx.memberMap.get(leaderId) : null;
    groups.push({
      name: raid.name || raid.raidId,
      meta: live.length
        ? `${live.length} part${live.length === 1 ? 'y' : 'ies'} · ${headcount} member${headcount === 1 ? '' : 's'}`
        : 'empty',
      leaderName: leaderOk ? ((leader && (leader.displayName || leader.username)) || leaderId) : null,
      parties: live,
      headcount,
    });
  }

  // Orphans — parties whose raid doc is missing. Shouldn't happen (the web app
  // seeds raids and parties together) but drawing them beats losing them.
  for (const [raidId, list] of byRaid) {
    if (seen.has(raidId)) continue;
    const live = list.filter(p => !isEmptyParty(p));
    if (!live.length) continue;
    const headcount = live.reduce((s, p) => s + (p.memberIds || []).length, 0);
    groups.push({
      name: raidId,
      meta: `${live.length} part${live.length === 1 ? 'y' : 'ies'} · ${headcount} member${headcount === 1 ? '' : 's'}`,
      leaderName: null,
      parties: live,
      headcount,
    });
  }

  const guildLabel = guild === 'mummy' ? 'Mummy' : 'Daddy';
  const raidCount = groups.length;
  const partyCount = groups.reduce((s, g) => s + g.parties.length, 0);
  const headcount = groups.reduce((s, g) => s + g.headcount, 0);
  const band = `${guildLabel} · Siege — ${raidCount} raid${raidCount === 1 ? '' : 's'} · ${partyCount} part${partyCount === 1 ? 'y' : 'ies'} · ${headcount} member${headcount === 1 ? '' : 's'}`;

  return {
    title: 'Siege',
    raidCount,
    partyCount,
    headcount,
    // Per-raid summary of what the bands say — the command doesn't need it, the
    // sim harness asserts against it.
    raids: groups.map(g => ({
      name: g.name,
      leaderName: g.leaderName,
      partyCount: g.parties.length,
      headcount: g.headcount,
    })),
    filename: `siege-${guild}.png`,
    buffer: renderGroupedImage(band, layoutRaidGroups(groups), gctx),
  };
}

module.exports = {
  buildRaidImages,
  buildPolarityImages,
  buildSiegeImage,
  renderSectionImage,
  renderGroupedImage,
  renderNoticeImage,
  layoutSection,
  layoutRaidGroups,
  fitRows,
  maxLegibleCols,
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
  MAX_POOL_ROWS,
  MIN_CARD_W,
  IDEAL_CARD_W,
  CARD_GAP,
  MARGIN,
  RAID_LABEL_H,
};
