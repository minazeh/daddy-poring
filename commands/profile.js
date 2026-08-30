const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const rosterDb = require('../roster/db');
const kudosDb = require('../kudos/db');

// Clean green accent.
const COLOR = 0x57F287;

// --- Embed size budget -------------------------------------------------------
// Discord caps ONE embed at 6,000 characters counted across the title, every
// field name, every field value and the footer. A profile can now carry up to
// SIX member lists — GvG + Polarity + Siege, once for Daddy and again for
// Mummy — and six fields at the 1,024 per-field cap is 6,144 on their own, i.e.
// over the embed cap before a single other character is counted.
//
// So the lists share ONE budget instead of each policing itself: render them at
// the per-field clamp, MEASURE the real embed, and only if that exceeds
// SAFE_TOTAL re-render every list to an equal share of what is actually left.
// At the current party size of 5 this never fires — a list is ~200 chars — but
// it means a larger `settings.partySize`, or unusually long display names,
// degrades the lists instead of turning /profile into a 400 from Discord.
const SAFE_TOTAL = 5800;     // 6,000 cap minus headroom
const LIST_FIELD_CAP = 1000; // < the 1,024 per-field cap, room for the trailer
const MIN_LIST_CAP = 120;    // never squeeze a list below a couple of lines

// Ordered member docs keyed by id. Shared by all three layouts of one guild.
function buildMemberMap(members) {
  return new Map(members.map(m => [m.userId, m]));
}

// GvG layout. `parties` carry memberIds; the raid is found by looking for the
// raidGroup whose partyIds contains this party. Returns null when not in one.
function resolveGvgParty({ parties, raidGroups, memberMap }, userId) {
  const party = parties.find(p => (p.memberIds || []).includes(userId));
  if (!party) return null;
  const raid = raidGroups.find(r => (r.partyIds || []).includes(party.partyId));
  return { party, raidName: raid ? raid.name : 'Unassigned', memberMap };
}

// POLARITY and SIEGE layouts. Their parties carry `raidId` directly, so the raid
// is a straight lookup rather than the partyIds scan the GvG layout needs — the
// two collections are linked differently, and that difference is why this is a
// separate resolver rather than a flag on the one above.
//
// `kind` is carried through for polarity, where a "main" raid is the top-power
// group and worth saying out loud; siege raids have no such split and pass
// through as undefined.
function resolveRaidLinkedParty({ raids, parties, memberMap }, userId) {
  const party = parties.find(p => (p.memberIds || []).includes(userId));
  if (!party) return null;
  const raid = raids.find(r => r.raidId === party.raidId);
  return {
    party,
    raidName: raid ? (raid.name || raid.raidId) : 'Unassigned',
    kind: party.kind || raid?.kind,
    memberMap,
  };
}

// Every layout for one guild in a single trip, sharing one members read and one
// member map. Seven queries per guild rather than the three-per-layout the naive
// shape would cost. Read-only throughout — all three collections are web-owned.
async function loadGuildLayouts(guild, userId) {
  const [members, parties, raidGroups, polRaids, polParties, siegeRaids, siegeParties] =
    await Promise.all([
      rosterDb.getMembers(guild),
      rosterDb.getParties(guild),
      rosterDb.getRaidGroups(guild),
      rosterDb.getPolarityRaids(guild),
      rosterDb.getPolarityParties(guild),
      rosterDb.getSiegeRaids(guild),
      rosterDb.getSiegeParties(guild),
    ]);

  const memberMap = buildMemberMap(members);

  // All three layouts always come back, resolved or null. The profile renders
  // them as a fixed three-column row, so an absent layout is an em dash in its
  // column rather than a missing field — dropping one would collapse the row
  // to two columns and shuffle the others sideways.
  return {
    gvg: resolveGvgParty({ parties, raidGroups, memberMap }, userId),
    polarity: resolveRaidLinkedParty({ raids: polRaids, parties: polParties, memberMap }, userId),
    siege: resolveRaidLinkedParty({ raids: siegeRaids, parties: siegeParties, memberMap }, userId),
  };
}

// "**Party Name** (RaidName)" for a resolved party context, plus a second line
// for a polarity MAIN raid — the top-power group, in the wording /polarityraid
// uses. Bold because it now heads a column that also holds the member list, and
// the column is a third of the embed's width.
function partyNameValue(ctx) {
  if (!ctx) return '—';
  const head = `**${ctx.party.name}** (${ctx.raidName})`;
  return ctx.kind === 'main' ? `${head}\nMain raid (top power)` : head;
}

// Numbered member list "<n>. <displayName> - <className>", slot order, capped.
function partyMembersValue(ctx, cap = LIST_FIELD_CAP) {
  if (!ctx) return '—';
  const ids = ctx.party.memberIds || [];
  if (!ids.length) return '—';
  const lines = [];
  let len = 0;
  for (let i = 0; i < ids.length; i++) {
    const m = ctx.memberMap.get(ids[i]);
    const name = m?.displayName || m?.username || 'Unknown';
    const cls = m?.className || 'N/A';
    const line = `${i + 1}. ${name} - ${cls}`;
    if (len + line.length + 1 > cap) {
      lines.push(`+${ids.length - i} more`);
      break;
    }
    lines.push(line);
    len += line.length + 1;
  }
  return lines.join('\n');
}

// One column: the party heading and its member list in a single field value.
// Merged rather than split across two fields because Discord only puts INLINE
// fields side by side, and a heading field plus a list field would be two
// columns of the three available — the party and its members would end up in
// different columns of the row instead of stacked in one.
function layoutColumnValue(ctx, cap = LIST_FIELD_CAP) {
  if (!ctx) return '—';
  const head = partyNameValue(ctx);
  // The heading shares the field's budget with the list, so the list gets what
  // is left rather than the full cap.
  const list = partyMembersValue(ctx, Math.max(MIN_LIST_CAP, cap - head.length - 1));
  return `${head}\n${list}`;
}

// The three layouts for one guild as ONE ROW of three inline columns:
// Guild League | Polarity | Siege. `suffix` labels the secondary guild's row.
//
// All three are always emitted, even when the member is in none of them, so the
// row keeps its shape — Discord packs inline fields three to a row, so dropping
// one would pull the next guild's column up beside the survivors.
//
// Entries carry their ctx so the budget pass below can re-render them narrower.
function layoutFields(layouts, suffix = '') {
  const label = base => `${base}${suffix}`;
  const src = layouts || { gvg: null, polarity: null, siege: null };
  return [
    { name: label('Guild League'), value: layoutColumnValue(src.gvg), inline: true, isList: true, ctx: src.gvg },
    { name: label('Polarity'), value: layoutColumnValue(src.polarity), inline: true, isList: true, ctx: src.polarity },
    { name: label('Siege'), value: layoutColumnValue(src.siege), inline: true, isList: true, ctx: src.siege },
  ];
}

// The whole field list, in display order. Split out of execute() so the sim
// exercises the real assembly rather than a copy of it that can drift.
//   primary/secondary — loadGuildLayouts() results, or null.
function buildProfileFields({ username, ign, jobClass, powerText, kudos, kudosLimit, primary, secondary }) {
  // ROW PACKING MATTERS HERE. Discord lays inline fields out three to a row and
  // starts a new row only when three are used up or a non-inline field breaks
  // it. So every inline row above the layout row must contain exactly THREE
  // fields, or the layout row's first column gets pulled up to fill the gap and
  // the remaining two orphan onto the next line.
  //
  // That is why In-game Name is inline and grouped with Job Class and Power:
  // it completes that row. Username stays full-width and breaks the row above.
  const fields = [
    { name: 'Username', value: username, inline: false },
    { name: 'In-game Name', value: ign, inline: true },
    { name: 'Job Class', value: jobClass, inline: true },
    { name: 'Power', value: powerText, inline: true },
  ];

  // Kudos row — three columns, so it too leaves the next row clean. Omitted
  // entirely when kudos is unavailable, which is fine: three is still three.
  if (kudos) {
    const rankValue = kudos.total > 0 && kudos.rank
      ? `#${kudos.rank} of ${kudos.totalRecipients}`
      : 'Unranked';
    fields.push(
      { name: 'Kudos', value: `${kudos.total} received`, inline: true },
      { name: 'Rank', value: rankValue, inline: true },
      { name: 'Given Today', value: `${kudos.givenToday}/${kudosLimit}`, inline: true },
    );
  }

  // The layout row: Guild League | Polarity | Siege, three inline columns.
  // Always emitted — with every column an em dash when the roster is
  // unavailable — so the profile keeps one shape rather than two.
  fields.push(...layoutFields(primary));
  if (secondary) fields.push(...layoutFields(secondary, ' (Mummy)'));

  return fields;
}

// Total characters Discord counts against the 6,000-per-embed cap.
function embedChars(title, fields, footerText) {
  let n = (title || '').length + (footerText || '').length;
  for (const f of fields) n += f.name.length + f.value.length;
  return n;
}

// Measure, then shrink only if we have to. Mutates `fields` in place and returns
// the final measured size, so the command and the sim assert on the same number.
function fitFieldsToEmbed(title, fields, footerText) {
  const total = embedChars(title, fields, footerText);
  const lists = fields.filter(f => f.isList);
  if (total <= SAFE_TOTAL || !lists.length) return total;

  const listChars = lists.reduce((s, f) => s + f.value.length, 0);
  const nonList = total - listChars;
  const per = Math.max(MIN_LIST_CAP, Math.floor((SAFE_TOTAL - nonList) / lists.length));
  for (const f of lists) f.value = layoutColumnValue(f.ctx, per);

  return embedChars(title, fields, footerText);
}

// Drop the bookkeeping keys — EmbedBuilder validates what it is handed.
function toEmbedFields(fields) {
  return fields.map(f => ({ name: f.name, value: f.value, inline: !!f.inline }));
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('profile')
    .setDescription('Show a member\'s profile (defaults to you).')
    .addUserOption(option =>
      option
        .setName('user')
        .setDescription('Whose profile to view (defaults to you).')
        .setRequired(false),
    ),

  // Public (not ephemeral). Everyone can use it. Degrades gracefully.
  async execute(interaction) {
    await interaction.deferReply(); // public

    try {
      const guildId = interaction.guild?.id;
      const targetUser = interaction.options.getUser('user') ?? interaction.user;

      // --- Discord natives (with left-guild fetch fallback) -----------------
      const username = targetUser.username;
      let displayName = targetUser.globalName || targetUser.username;
      let avatarURL = targetUser.displayAvatarURL();
      let joinedAt = null;
      try {
        const member = await interaction.guild.members.fetch(targetUser.id);
        displayName = member.displayName;
        avatarURL = member.displayAvatarURL();
        joinedAt = member.joinedAt;
      } catch {
        // Left the server — use the user's global identity; no join date.
      }

      // --- Roster: class, power, guild membership ---------------------------
      let memberDoc = null;
      let power = null;
      const guilds = []; // 'daddy' and/or 'mummy'
      if (rosterDb.isReady()) {
        try {
          memberDoc = await rosterDb.getMember(targetUser.id);
          power = await rosterDb.getPower(targetUser.id);
          if (memberDoc?.isMain) guilds.push('daddy');
          if (memberDoc?.isSub) guilds.push('mummy');
        } catch (e) {
          console.warn('[profile] roster lookup failed:', e?.message || e);
        }
      }

      // In-game Name = server nickname; fall back to roster displayName, else username.
      const ign = displayName || memberDoc?.displayName || username;
      const jobClass = memberDoc?.className || 'N/A';
      const powerText = power && power > 0 ? `${power}` : 'Unrated';

      // --- Kudos (graceful if disabled) ------------------------------------
      let kudos = null; // { total, rank, totalRecipients, givenToday }
      if (kudosDb.isReady() && guildId) {
        try {
          const { total, rank, totalRecipients } = await kudosDb.rankForRecipient(guildId, targetUser.id);
          const givenToday = await kudosDb.countGivenToday(targetUser.id);
          kudos = { total, rank, totalRecipients, givenToday };
        } catch (e) {
          console.warn('[profile] kudos lookup failed:', e?.message || e);
        }
      }

      // Primary guild for the 3-col row (Daddy preferred), secondary for both.
      const primaryGuild = guilds.includes('daddy') ? 'daddy' : (guilds.includes('mummy') ? 'mummy' : null);
      const secondaryGuild = guilds.length === 2 ? 'mummy' : null;

      // --- All three layouts, per guild -------------------------------------
      let primary = null;
      let secondary = null;
      if (rosterDb.isReady()) {
        try {
          if (primaryGuild) primary = await loadGuildLayouts(primaryGuild, targetUser.id);
          if (secondaryGuild) secondary = await loadGuildLayouts(secondaryGuild, targetUser.id);
        } catch (e) {
          console.warn('[profile] layout resolution failed:', e?.message || e);
        }
      }

      // --- Build embed ------------------------------------------------------
      const title = 'Your Profile';
      const joinDate = joinedAt ? new Date(joinedAt).toDateString() : 'Unknown';
      const footerText = `Member Since: ${joinDate}`;

      const fields = buildProfileFields({
        username,
        ign,
        jobClass,
        powerText,
        kudos,
        kudosLimit: kudosDb.DAILY_LIMIT,
        primary,
        secondary,
      });

      fitFieldsToEmbed(title, fields, footerText);

      const embed = new EmbedBuilder()
        .setTitle(title)
        .setColor(COLOR)
        .setThumbnail(avatarURL)
        .addFields(toEmbedFields(fields))
        .setFooter({ text: footerText, iconURL: avatarURL })
        .setTimestamp();

      await interaction.editReply({
        content: `Hi <@${targetUser.id}>: Here is your profile:`,
        embeds: [embed],
        allowedMentions: { parse: [] }, // render the mention without pinging
      });
    } catch (err) {
      console.warn('[profile] Failed:', err?.message || err);
      await interaction.editReply("Couldn't load that profile right now — please try again in a moment.");
    }
  },
};

// Exported for scripts/sim-profile.js — not used by the command itself.
module.exports._internals = {
  resolveGvgParty,
  resolveRaidLinkedParty,
  buildMemberMap,
  partyNameValue,
  partyMembersValue,
  layoutColumnValue,
  layoutFields,
  buildProfileFields,
  toEmbedFields,
  embedChars,
  fitFieldsToEmbed,
  SAFE_TOTAL,
  LIST_FIELD_CAP,
  MIN_LIST_CAP,
};
