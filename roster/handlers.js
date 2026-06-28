// ---------------------------------------------------------------------------
// Guild-roster embed building for /guildroster.
//
// Pure(ish) rendering logic — takes plain data objects (members, parties,
// raidGroups, settings) and returns an array of discord.js EmbedBuilder
// instances: ONE EMBED PER RAID GROUP (Conrad's explicit choice), plus a
// per-field "Unassigned Parties" embed where applicable.
//
// Class→role + required-class logic is inlined here (the web app lives in a
// separate repo). Defaults below MUST match the web app's defaults.
//
// Discord hard limits respected: embed total ≤6000 chars, title ≤256, each
// field value ≤1024, ≤25 fields/embed, ≤10 embeds/message (chunking is the
// caller's job via chunkEmbeds()).
// ---------------------------------------------------------------------------

const { EmbedBuilder } = require('discord.js');

// Default class→role map (web-app parity). Prefer settings.classRoles when the
// settings doc exists; fall back to this otherwise.
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

const ROLE_ICONS = { tank: '🛡️', healer: '⚕️', dps: '⚔️' };

const DEFAULT_REQUIRED_CLASSES = [{ className: 'Priest', min: 1 }];
const DEFAULT_PARTY_SIZE = 5;

// Embed accents.
const COLOR_MAIN = 0xFFD700; // gold  → Main field
const COLOR_SUB = 0xB566D6;  // purple → Sub field
const COLOR_WARN = 0xE74C3C; // red   → raid contains a party missing a required class

// Per-message embed cap.
const MAX_EMBEDS_PER_MESSAGE = 10;

// Discord limits (with margins for the 6000 total).
const MAX_TITLE = 256;
const MAX_FIELD_VALUE = 1024;
const MAX_FIELDS = 25;
const EMBED_CHAR_BUDGET = 5800; // < 6000 hard cap, leaves room for footer/title growth
const FIELD_VALUE_BUDGET = 1000; // < 1024 hard cap, leaves room for the "…and N more" note

// ---------------------------------------------------------------------------
// Small string helpers
// ---------------------------------------------------------------------------
function trunc(s, max) {
  if (typeof s !== 'string') return s;
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

function isEmptyParty(p) {
  return !p || !Array.isArray(p.memberIds) || p.memberIds.length === 0;
}

// ---------------------------------------------------------------------------
// Class → role resolution
// ---------------------------------------------------------------------------
function classToRole(className, classRoles) {
  if (!className) return 'dps';
  const map = classRoles || DEFAULT_CLASS_ROLES;
  return map[className] || 'dps';
}

function roleIcon(role) {
  return ROLE_ICONS[role] || ROLE_ICONS.dps;
}

// ---------------------------------------------------------------------------
// Required-class check — returns the list of className strings the party is
// missing (count < min). Computed live from the party's memberIds.
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// One member line: "<roleIcon> displayName (className)". Members not in the map
// (departed but still referenced) fall back to a non-pinging mention.
// ---------------------------------------------------------------------------
function memberLine(userId, ctx) {
  const m = ctx.memberMap.get(userId);
  if (!m) return `${ROLE_ICONS.dps} <@${userId}>`; // departed / unknown
  const icon = roleIcon(classToRole(m.className, ctx.classRoles));
  const cls = m.className || 'no class';
  const name = m.displayName || m.username || `<@${userId}>`;
  return `${icon} ${name} (${cls})`;
}

// Field value for one party — member lines, truncated under the 1024 cap.
function buildPartyValue(party, ctx) {
  const ids = party.memberIds || [];
  if (!ids.length) return '_(empty)_';
  const lines = [];
  let budget = 0;
  for (let i = 0; i < ids.length; i++) {
    const line = memberLine(ids[i], ctx);
    if (budget + line.length + 1 > FIELD_VALUE_BUDGET) {
      lines.push(`…and ${ids.length - i} more`);
      break;
    }
    lines.push(line);
    budget += line.length + 1;
  }
  // Hard safety clamp on the 1024 cap.
  return trunc(lines.join('\n'), MAX_FIELD_VALUE);
}

// Build embed fields for a list of (non-empty) parties. Returns the fields and
// whether any party is missing a required class (drives the warn color).
function buildPartyFields(partiesList, ctx) {
  const fields = [];
  let anyMissing = false;
  for (const p of partiesList) {
    const missing = computeMissing(p, ctx);
    if (missing.length) anyMissing = true;
    const count = (p.memberIds || []).length;
    let name = `${p.name || p.partyId} (${count}/${ctx.partySize})`;
    if (missing.length) name += ` ⚠ missing: ${missing.join(', ')}`;
    fields.push({ name: trunc(name, MAX_TITLE), value: buildPartyValue(p, ctx) });
  }
  return { fields, anyMissing };
}

// ---------------------------------------------------------------------------
// Pack fields into one-or-more embeds for a single raid (or Unassigned group),
// splitting on the 25-field and ~6000-char limits. Continuation embeds get a
// " (cont. N)" title suffix.
// ---------------------------------------------------------------------------
function packEmbeds(rawTitle, color, fields) {
  const title = trunc(rawTitle, MAX_TITLE);
  const out = [];
  let cur = [];
  let curChars = title.length;
  let part = 0;

  const flush = () => {
    const t = part === 0 ? title : trunc(`${title} (cont. ${part + 1})`, MAX_TITLE);
    const e = new EmbedBuilder().setColor(color).setTitle(t);
    if (cur.length) e.addFields(cur);
    out.push(e);
    part += 1;
    cur = [];
    curChars = t.length;
  };

  for (const f of fields) {
    const fchars = (f.name?.length || 0) + (f.value?.length || 0);
    if (cur.length >= MAX_FIELDS || (cur.length > 0 && curChars + fchars > EMBED_CHAR_BUDGET)) {
      flush();
    }
    cur.push(f);
    curChars += fchars;
  }
  flush(); // always emit at least one embed (possibly empty-field, with the title)
  return out;
}

// ---------------------------------------------------------------------------
// Build all embeds for a guild. ONE EMBED PER RAID GROUP (split on limits),
// Main field first then Sub, then per-field Unassigned Parties.
//
// data = { members, parties, raidGroups, settings }
// ---------------------------------------------------------------------------
function buildGuildEmbeds(guild, data) {
  const { members = [], parties = [], raidGroups = [], settings = null } = data;

  const memberMap = new Map(members.map(m => [m.userId, m]));
  const partyMap = new Map(parties.map(p => [p.partyId, p]));

  const ctx = {
    memberMap,
    classRoles: (settings && settings.classRoles) || DEFAULT_CLASS_ROLES,
    requiredClasses:
      settings && Array.isArray(settings.requiredClasses) && settings.requiredClasses.length
        ? settings.requiredClasses
        : DEFAULT_REQUIRED_CLASSES,
    partySize: (settings && settings.partySize) || DEFAULT_PARTY_SIZE,
  };

  const guildLabel = guild === 'mummy' ? 'Mummy' : 'Daddy';
  const embeds = [];

  for (const field of ['main', 'sub']) {
    const fieldLabel = field === 'main' ? 'Main Field' : 'Sub Field';
    const baseColor = field === 'main' ? COLOR_MAIN : COLOR_SUB;

    // raidGroups arrive sorted by position from the db layer.
    const raids = raidGroups.filter(r => r.field === field);
    const assignedPartyIds = new Set();

    for (const raid of raids) {
      const raidPartyIds = raid.partyIds || [];
      raidPartyIds.forEach(id => assignedPartyIds.add(id));

      const raidParties = raidPartyIds.map(id => partyMap.get(id)).filter(Boolean);
      const nonEmpty = raidParties.filter(p => !isEmptyParty(p));
      const title = `${guildLabel} · ${fieldLabel} · ${raid.name}`;

      if (nonEmpty.length === 0) {
        // Raid exists but every party is empty (or unresolved) — still emit it.
        embeds.push(
          new EmbedBuilder()
            .setColor(baseColor)
            .setTitle(trunc(title, MAX_TITLE))
            .setDescription('_All parties in this raid are currently empty._'),
        );
        continue;
      }

      const { fields, anyMissing } = buildPartyFields(nonEmpty, ctx);
      embeds.push(...packEmbeds(title, anyMissing ? COLOR_WARN : baseColor, fields));
    }

    // Unassigned: parties in this (type, field) not referenced by any raid group,
    // non-empty only.
    const unassigned = parties
      .filter(p => p.field === field && !assignedPartyIds.has(p.partyId) && !isEmptyParty(p))
      .sort((a, b) => (a.position || 0) - (b.position || 0));

    if (unassigned.length) {
      const title = `${guildLabel} · ${fieldLabel} · Unassigned Parties`;
      const { fields, anyMissing } = buildPartyFields(unassigned, ctx);
      embeds.push(...packEmbeds(title, anyMissing ? COLOR_WARN : baseColor, fields));
    }
  }

  // True empty state — nothing to show at all.
  if (embeds.length === 0) {
    embeds.push(
      new EmbedBuilder()
        .setColor(COLOR_MAIN)
        .setTitle(`${guildLabel} Roster`)
        .setDescription(`No parties set up yet for ${guildLabel}.`),
    );
  }

  return embeds;
}

// Split an embed array into chunks of ≤10 for sending across messages.
function chunkEmbeds(embeds, size = MAX_EMBEDS_PER_MESSAGE) {
  const chunks = [];
  for (let i = 0; i < embeds.length; i += size) {
    chunks.push(embeds.slice(i, i + size));
  }
  return chunks;
}

module.exports = {
  // main entry points
  buildGuildEmbeds,
  chunkEmbeds,
  // exported for tests / the live simulation
  classToRole,
  roleIcon,
  computeMissing,
  memberLine,
  buildPartyValue,
  buildPartyFields,
  packEmbeds,
  isEmptyParty,
  DEFAULT_CLASS_ROLES,
  ROLE_ICONS,
  DEFAULT_REQUIRED_CLASSES,
  DEFAULT_PARTY_SIZE,
  MAX_EMBEDS_PER_MESSAGE,
};
