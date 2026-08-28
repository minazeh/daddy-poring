// ---------------------------------------------------------------------------
// Rendering — the board embed, the ephemeral views, and the select menus.
//
// Spec: docs/OFFICER_CARRY_SCHEDULER_SPEC.md §3 and §7.3.
//
// PURE. Nothing here touches Discord or Mongo; every function takes a week
// document and returns payload objects. That is what lets the simulation assert
// the embed budget and the option counts offline.
// ---------------------------------------------------------------------------

const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  StringSelectMenuBuilder,
} = require('discord.js');

const {
  IDS,
  DAYS,
  COLORS,
  DOT_FILLED,
  DOT_FREE,
  MAX_MEMBERS_PER_SLOT,
  EMBED_FIELD_VALUE_LIMIT,
  EMBED_TOTAL_LIMIT,
  SELECT_OPTION_LIMIT,
  PANEL_TITLE,
  TZ_LABEL,
} = require('./constants');

const {
  slotKeysForDay,
  slotMinutesForDay,
  slotKey,
  hhmm,
  dayHeading,
  weekHeading,
  parseSlotKey,
} = require('./grid');

// ---------------------------------------------------------------------------
// Small helpers.
// ---------------------------------------------------------------------------
function slotOf(doc, key) {
  return doc?.slots?.[key] || { officers: [], members: [] };
}

function isOpen(doc, key) {
  return (slotOf(doc, key).officers?.length || 0) > 0;
}

function fillDots(count) {
  const n = Math.min(count, MAX_MEMBERS_PER_SLOT);
  return DOT_FILLED.repeat(n) + DOT_FREE.repeat(MAX_MEMBERS_PER_SLOT - n);
}

/** 'Kaito' or 'Kaito +2' — the board shows one name plus a count, not a list. */
function officerLabel(slot) {
  const names = (slot.officers || []).map(o => o.displayName).filter(Boolean);
  if (!names.length) return '';
  return names.length === 1 ? names[0] : `${names[0]} +${names.length - 1}`;
}

/**
 * One board line: `18:00 ●●○ Kaito`, with FULL appended at capacity.
 * Names are truncated so a long display name cannot blow the field budget on
 * its own.
 */
function boardLine(minutes, slot) {
  const count = slot.members?.length || 0;
  const full = count >= MAX_MEMBERS_PER_SLOT ? '  FULL' : '';
  let who = officerLabel(slot);
  if (who.length > 24) who = `${who.slice(0, 23)}…`;
  return `\`${hhmm(minutes)}\` ${fillDots(count)} ${who}${full}`;
}

// ---------------------------------------------------------------------------
// The board.
//
// Only slots an officer has opened are listed. Showing all 108 would bury the
// handful that matter, and would not fit the embed budget anyway.
// ---------------------------------------------------------------------------
function panelEmbed(doc) {
  const weekStart = doc?.weekStartAt ? new Date(doc.weekStartAt) : new Date();

  const embed = new EmbedBuilder()
    .setColor(COLORS.PANEL)
    .setTitle(PANEL_TITLE)
    .setDescription(
      `Week of **${weekHeading(weekStart)}** · all times **${TZ_LABEL}**\n` +
      `Officers open a slot with **I'm available**. Members then **Join** it — ` +
      `up to **${MAX_MEMBERS_PER_SLOT}** per slot, and you're in straight away.`,
    );

  let totalOpen = 0;
  let totalJoined = 0;

  for (const day of DAYS) {
    const lines = [];
    let dropped = 0;

    for (const minutes of slotMinutesForDay(day.key)) {
      const key = slotKey(day.key, minutes);
      const slot = slotOf(doc, key);
      if (!slot.officers?.length) continue;

      totalOpen += 1;
      totalJoined += slot.members?.length || 0;

      const line = boardLine(minutes, slot);
      // §7.3: keep the field inside 1024 rather than letting Discord reject the
      // whole edit, which would freeze the board rather than trim it.
      const projected = lines.join('\n').length + line.length + 1;
      if (projected > EMBED_FIELD_VALUE_LIMIT - 24) { dropped += 1; continue; }
      lines.push(line);
    }

    if (dropped > 0) lines.push(`…and ${dropped} more`);

    embed.addFields({
      name: dayHeading(day.key, weekStart),
      value: lines.length ? lines.join('\n') : '_no slots open_',
      inline: true,
    });
  }

  embed.setFooter({
    text: totalOpen
      ? `${totalOpen} slot${totalOpen === 1 ? '' : 's'} open · ${totalJoined} joined`
      : 'No slots open yet — officers, mark your availability.',
  });

  return embed;
}

function panelComponents() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(IDS.JOIN_BUTTON)
        .setLabel('Join a slot')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(IDS.AVAIL_BUTTON)
        .setLabel("I'm available")
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId(IDS.MINE_BUTTON)
        .setLabel('My slots')
        .setStyle(ButtonStyle.Secondary),
    ),
  ];
}

function panelPayload(doc) {
  return { embeds: [panelEmbed(doc)], components: panelComponents() };
}

/**
 * Total rendered size of the board, for the §7.3 budget assertion. Counts every
 * field name and value plus the title and description, which is what Discord's
 * 6000 limit actually measures.
 */
function embedSize(embed) {
  const d = typeof embed.toJSON === 'function' ? embed.toJSON() : embed;
  let n = (d.title || '').length + (d.description || '').length + (d.footer?.text || '').length;
  for (const f of d.fields || []) n += (f.name || '').length + (f.value || '').length;
  return n;
}

// ---------------------------------------------------------------------------
// Day select. `openOnly` is the difference between the join flow (days with
// something to join) and the availability flow (all seven).
// ---------------------------------------------------------------------------
function daySelect(doc, customId, { openOnly }) {
  const options = [];

  for (const day of DAYS) {
    const keys = slotKeysForDay(day.key);
    const open = keys.filter(k => isOpen(doc, k));
    if (openOnly && open.length === 0) continue;

    const free = open.filter(
      k => (slotOf(doc, k).members?.length || 0) < MAX_MEMBERS_PER_SLOT,
    ).length;

    options.push({
      label: dayHeading(day.key, new Date(doc.weekStartAt)),
      value: day.key,
      description: openOnly
        ? `${free} slot${free === 1 ? '' : 's'} with space`
        : `${open.length} of ${keys.length} open`,
    });
  }

  if (!options.length) return null;

  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(customId)
      .setPlaceholder('Pick a day')
      .addOptions(options.slice(0, SELECT_OPTION_LIMIT)),
  );
}

// ---------------------------------------------------------------------------
// Slot select for one day.
//
// The largest day is 24 slots and a select holds 25, so a whole day always fits
// in one menu with no paging (spec §2.1). The slice is a belt-and-braces guard
// in case the grid is ever widened without revisiting this.
// ---------------------------------------------------------------------------
function slotSelect(doc, dayKey, customId, { openOnly }) {
  const options = [];

  for (const minutes of slotMinutesForDay(dayKey)) {
    const key = slotKey(dayKey, minutes);
    const slot = slotOf(doc, key);
    const open = (slot.officers?.length || 0) > 0;
    if (openOnly && !open) continue;

    const count = slot.members?.length || 0;
    let description;
    if (openOnly) {
      description = count >= MAX_MEMBERS_PER_SLOT
        ? 'FULL'
        : `${count}/${MAX_MEMBERS_PER_SLOT} joined · ${officerLabel(slot)}`;
    } else {
      description = open ? `open · ${officerLabel(slot)}` : 'not open yet';
    }

    options.push({
      label: hhmm(minutes),
      value: key,
      description: description.slice(0, 100),
    });
  }

  if (!options.length) return null;

  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(customId)
      .setPlaceholder('Pick a time')
      .addOptions(options.slice(0, SELECT_OPTION_LIMIT)),
  );
}

// ---------------------------------------------------------------------------
// "My slots" — everything this user is on, both sides, each with a way out.
//
// Discord caps a message at 5 rows, so at most 5 leave buttons are shown and
// the rest are named in the text. Anyone with more than five slots in one week
// can act on them across two presses.
// ---------------------------------------------------------------------------
function mineView(doc, userId) {
  const weekStart = new Date(doc.weekStartAt);
  const asMember = [];
  const asOfficer = [];

  for (const day of DAYS) {
    for (const minutes of slotMinutesForDay(day.key)) {
      const key = slotKey(day.key, minutes);
      const slot = slotOf(doc, key);
      const label = `${dayHeading(day.key, weekStart)} ${hhmm(minutes)}`;
      if (slot.members?.some(m => m.userId === userId)) asMember.push({ key, label, slot });
      if (slot.officers?.some(o => o.userId === userId)) asOfficer.push({ key, label, slot });
    }
  }

  const lines = [];
  if (asOfficer.length) {
    lines.push('**Running (you are available)**');
    for (const s of asOfficer) {
      const n = s.slot.members?.length || 0;
      lines.push(`• ${s.label} — ${n}/${MAX_MEMBERS_PER_SLOT} joined`);
    }
  }
  if (asMember.length) {
    if (lines.length) lines.push('');
    lines.push('**Joined**');
    for (const s of asMember) lines.push(`• ${s.label} — ${officerLabel(s.slot)}`);
  }
  if (!lines.length) lines.push('You are not on any slot this week.');

  const rows = [];
  for (const s of asOfficer.slice(0, 5)) {
    rows.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`${IDS.OFFICER_WITHDRAW}:${s.key}`)
        .setLabel(`Withdraw — ${s.label}`.slice(0, 80))
        .setStyle(ButtonStyle.Danger),
    ));
  }
  for (const s of asMember.slice(0, Math.max(0, 5 - rows.length))) {
    rows.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`${IDS.LEAVE}:${s.key}`)
        .setLabel(`Leave — ${s.label}`.slice(0, 80))
        .setStyle(ButtonStyle.Secondary),
    ));
  }

  const hidden = (asOfficer.length + asMember.length) - rows.length;
  if (hidden > 0) lines.push(`\n_${hidden} more not shown — press **My slots** again after acting on these._`);

  return { content: lines.join('\n'), components: rows };
}

/** Detail for one slot, used in the join confirmation. Names live here, not on the board. */
function slotDetail(doc, key) {
  const parsed = parseSlotKey(key);
  const slot = slotOf(doc, key);
  if (!parsed) return 'that slot';
  const when = `${dayHeading(parsed.dayKey, new Date(doc.weekStartAt))} ${parsed.hhmm} ${TZ_LABEL}`;
  const officers = (slot.officers || []).map(o => o.displayName).join(', ') || 'nobody yet';
  const members = (slot.members || []).map(m => m.displayName).join(', ') || 'nobody yet';
  const n = slot.members?.length || 0;
  return `**${when}**\nRunning: ${officers}\nJoined (${n}/${MAX_MEMBERS_PER_SLOT}): ${members}`;
}

module.exports = {
  slotOf,
  isOpen,
  fillDots,
  officerLabel,
  boardLine,
  panelEmbed,
  panelComponents,
  panelPayload,
  embedSize,
  daySelect,
  slotSelect,
  mineView,
  slotDetail,
  EMBED_TOTAL_LIMIT,
};
