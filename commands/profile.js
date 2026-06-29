const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const rosterDb = require('../roster/db');
const kudosDb = require('../kudos/db');

// Clean green accent.
const COLOR = 0x57F287;

// Resolve a guild's party context for a user: the party they're in, its raid
// name (or "Unassigned"), and the ordered member docs. Read-only; never throws.
// Returns { party, raidName, members[] } or null when not in a party.
async function resolveGuildParty(guild, userId) {
  const [members, parties, raids] = await Promise.all([
    rosterDb.getMembers(guild),
    rosterDb.getParties(guild),
    rosterDb.getRaidGroups(guild),
  ]);
  const party = parties.find(p => (p.memberIds || []).includes(userId));
  if (!party) return null;
  const raid = raids.find(r => (r.partyIds || []).includes(party.partyId));
  const memberMap = new Map(members.map(m => [m.userId, m]));
  return { party, raidName: raid ? raid.name : 'Unassigned', memberMap };
}

// "Party Name (RaidName)" for a resolved party context.
function partyNameValue(ctx) {
  if (!ctx) return '—';
  return `${ctx.party.name} (${ctx.raidName})`;
}

// Numbered member list "<n>. <displayName> - <className>", slot order, 1024-cap.
function partyMembersValue(ctx) {
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
    if (len + line.length + 1 > 1000) { // < 1024 cap, room for trailer
      lines.push(`+${ids.length - i} more`);
      break;
    }
    lines.push(line);
    len += line.length + 1;
  }
  return lines.join('\n');
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

      // --- Roster: class, power, guild membership, party contexts -----------
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

      let primaryCtx = null;
      let secondaryCtx = null;
      if (rosterDb.isReady()) {
        try {
          if (primaryGuild) primaryCtx = await resolveGuildParty(primaryGuild, targetUser.id);
          if (secondaryGuild) secondaryCtx = await resolveGuildParty(secondaryGuild, targetUser.id);
        } catch (e) {
          console.warn('[profile] party resolution failed:', e?.message || e);
        }
      }

      // --- Build embed ------------------------------------------------------
      const embed = new EmbedBuilder()
        .setTitle('Your Profile')
        .setColor(COLOR)
        .setThumbnail(avatarURL);

      embed.addFields(
        { name: 'Username', value: username, inline: false },
        { name: 'In-game Name', value: ign, inline: false },
      );

      // Kudos row (3 cols) — comes BEFORE party/class/power. Only when available.
      if (kudos) {
        const rankValue = kudos.total > 0 && kudos.rank
          ? `#${kudos.rank} of ${kudos.totalRecipients}`
          : 'Unranked';
        embed.addFields(
          { name: 'Kudos', value: `${kudos.total} received`, inline: true },
          { name: 'Rank', value: rankValue, inline: true },
          { name: 'Given Today', value: `${kudos.givenToday}/${kudosDb.DAILY_LIMIT}`, inline: true },
        );
      }

      embed.addFields(
        // 3-col row: Party Name | Job Class | Power
        { name: 'Party Name', value: partyNameValue(primaryCtx), inline: true },
        { name: 'Job Class', value: jobClass, inline: true },
        { name: 'Power', value: powerText, inline: true },
        { name: 'Party Members', value: partyMembersValue(primaryCtx), inline: false },
      );

      // Both-guilds: append the secondary guild's party block.
      if (secondaryGuild) {
        embed.addFields(
          { name: 'Party Name (Mummy)', value: partyNameValue(secondaryCtx), inline: false },
          { name: 'Party Members (Mummy)', value: partyMembersValue(secondaryCtx), inline: false },
        );
      }

      const joinDate = joinedAt ? new Date(joinedAt).toDateString() : 'Unknown';
      embed.setFooter({ text: `Member Since: ${joinDate}`, iconURL: avatarURL });
      embed.setTimestamp();

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
