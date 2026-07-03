// ---------------------------------------------------------------------------
// Shared presentation helpers for the RoworldDB commands
// (/monster /item /card /map). Pure functions — no I/O, no Discord calls,
// except buildAutocomplete which wires a search fn to an interaction.
// ---------------------------------------------------------------------------

// Every rodb embed carries this attribution (Conrad-confirmed decision).
const FOOTER = 'Data: roworlddb.com';

// Quality tiers 1–6 → embed accent color (grey/green/blue/purple/orange/red).
const QUALITY_COLORS = {
  1: 0x95a5a6,
  2: 0x2ecc71,
  3: 0x3498db,
  4: 0x9b59b6,
  5: 0xe67e22,
  6: 0xe74c3c,
};
const DEFAULT_COLOR = 0x5865f2;

function qualityColor(quality) {
  return QUALITY_COLORS[quality] ?? DEFAULT_COLOR;
}

// Drop-rate percent → compact human string ("10%", "0.42%", "0.0117%").
function fmtPct(pct) {
  if (typeof pct !== 'number' || !Number.isFinite(pct)) return null;
  let s;
  if (pct >= 1) s = pct.toFixed(2);
  else if (pct >= 0.01) s = pct.toFixed(3);
  else s = pct.toFixed(4);
  return `${s.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '')}%`;
}

// Clamp a string to Discord's per-field limit, on a line boundary when the
// input is multi-line. Field values max 1024; descriptions 4096.
function clampField(text, max = 1024) {
  if (!text) return text;
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 2);
  const nl = cut.lastIndexOf('\n');
  return `${nl > 0 ? cut.slice(0, nl) : cut}\n…`.slice(0, max);
}

// Join up to `maxLines` of `lines`, appending "… and N more" when truncated.
function joinLines(lines, maxLines = 12, max = 1024) {
  if (!lines.length) return null;
  const shown = lines.slice(0, maxLines);
  if (lines.length > maxLines) shown.push(`… and ${lines.length - maxLines} more`);
  return clampField(shown.join('\n'), max);
}

// Signed stat string: {name:'Max HP%', value:5, isPercent:true} → "Max HP% +5%".
function fmtStat({ name, value, isPercent }) {
  const sign = value < 0 ? '' : '+'; // negatives already carry '-'
  return `${name} ${sign}${value}${isPercent ? '%' : ''}`;
}

// Autocomplete choice label, clamped to Discord's 100-char limit.
function choiceLabel(label) {
  return label.length <= 100 ? label : `${label.slice(0, 99)}…`;
}

// ---------------------------------------------------------------------------
// buildAutocomplete(searchFn, labelFn) → async handler for command.autocomplete.
//   searchFn(query, limit) → docs (must resolve [] when DB down — rodb/db.js does)
//   labelFn(doc) → disambiguated display label (duplicate names are common:
//                  375 monsters / 547 items / 40 maps share a name)
// Choice value = String(_id) so execute() resolves the exact record.
// Never throws: any failure → respond([]).
// ---------------------------------------------------------------------------
function buildAutocomplete(searchFn, labelFn) {
  return async (interaction) => {
    let choices = [];
    try {
      const query = interaction.options.getFocused() ?? '';
      const docs = await searchFn(query, 25);
      // Duplicate names are common in this dataset; when even the
      // disambiguated label repeats within one result set (e.g. five
      // identical "Goblin (Lv 15 · Normal)" variants), suffix the id so
      // every choice is tellable apart.
      const seen = new Map();
      choices = docs
        .filter((d) => d.name)
        .slice(0, 25)
        .map((d) => {
          let label = labelFn(d);
          const n = seen.get(label) || 0;
          seen.set(label, n + 1);
          if (n > 0) label = `${label} [#${d._id}]`;
          return { name: choiceLabel(label), value: String(d._id) };
        });
    } catch (err) {
      console.warn('[rodb/format] autocomplete search failed:', err?.message || err);
      choices = [];
    }
    try {
      await interaction.respond(choices);
    } catch (err) {
      // Expired 3 s window or double-respond — nothing useful to do.
      console.warn('[rodb/format] autocomplete respond failed:', err?.message || err);
    }
  };
}

// ---------------------------------------------------------------------------
// resolveSelection(input, {getById, search}) → doc | null.
// Autocomplete sends String(_id); free-typed text falls back to best name match.
// ---------------------------------------------------------------------------
async function resolveSelection(input, { getById, search }) {
  const raw = String(input || '').trim();
  if (!raw) return null;
  if (/^\d+$/.test(raw)) {
    const doc = await getById(raw);
    if (doc) return doc;
  }
  const matches = await search(raw, 1);
  return matches[0] || null;
}

const NOT_AVAILABLE_MSG =
  "The game database isn't available right now — it may not be imported yet. Ask an admin.";

const notFoundMsg = (kind, input) =>
  `Couldn't find a ${kind} matching **${String(input).slice(0, 80)}** — try picking from the autocomplete list.`;

module.exports = {
  FOOTER,
  qualityColor,
  DEFAULT_COLOR,
  fmtPct,
  fmtStat,
  clampField,
  joinLines,
  choiceLabel,
  buildAutocomplete,
  resolveSelection,
  NOT_AVAILABLE_MSG,
  notFoundMsg,
};
