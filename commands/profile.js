const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const kudosDb = require('../kudos/db');
const rosterDb = require('../roster/db');
const { classToRole, ROLE_LABEL, ROLE_EMOJI } = require('../roster/roles');

// Role-based accent colors (match the roster image badges).
const ROLE_COLOR = { tank: 0x3b82f6, healer: 0x22c55e, dps: 0xf97316 };
const DEFAULT_COLOR = 0x5865f2;

// Cap on how many server roles we list.
const MAX_ROLES = 12;

// Discord timestamp helpers — <t:unix:D> (date) + <t:unix:R> (relative).
function tsLine(ms) {
  if (!ms) return null;
  const s = Math.floor(ms / 1000);
  return `<t:${s}:D>\n<t:${s}:R>`;
}

// Resolve the member's party + raid within one guild (daddy/mummy).
// Returns a display string. Read-only; never throws to the caller.
async function resolveParty(guild, userId) {
  try {
    const [parties, raids] = await Promise.all([
      rosterDb.getParties(guild),
      rosterDb.getRaidGroups(guild),
    ]);
    const party = parties.find(p => (p.memberIds || []).includes(userId));
    if (!party) return 'Not in a party';
    const fieldLabel = party.field === 'sub' ? 'Sub' : 'Main';
    const raid = raids.find(r => (r.partyIds || []).includes(party.partyId));
    const raidText = raid ? raid.name : 'Unassigned';
    return `${party.name} · ${fieldLabel} field\n→ Raid: ${raidText}`;
  } catch {
    return '—';
  }
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('profile')
    .setDescription('Show everything about a member (defaults to you).')
    .addUserOption(option =>
      option
        .setName('user')
        .setDescription('Whose profile to view (defaults to you).')
        .setRequired(false),
    ),

  // Public (not ephemeral). Everyone can use it. Degrades per-source.
  async execute(interaction) {
    await interaction.deferReply(); // public

    try {
      const guildId = interaction.guild?.id;
      const targetUser = interaction.options.getUser('user') ?? interaction.user;

      // --- Discord natives (with left-guild fetch fallback) -----------------
      let member = null;
      let displayName = targetUser.globalName || targetUser.username;
      let avatarURL = targetUser.displayAvatarURL();
      let joinedMs = null;
      let inServer = false;
      let roleNames = [];
      try {
        member = await interaction.guild.members.fetch(targetUser.id);
        inServer = true;
        displayName = member.displayName;
        avatarURL = member.displayAvatarURL();
        joinedMs = member.joinedTimestamp;
        roleNames = member.roles.cache
          .filter(r => r.id !== interaction.guild.id) // drop @everyone
          .sort((a, b) => b.position - a.position)
          .map(r => r.name);
      } catch {
        // Left the server — use the user's global identity.
      }
      const createdMs = targetUser.createdTimestamp;

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

      // --- Roster / class / power / party / raid (graceful if disabled) ----
      let memberDoc = null;
      let settings = null;
      let power = null;       // null = couldn't read; number = rating (0 = unrated)
      let guilds = [];        // ['daddy'] / ['mummy'] / both
      let partyDaddy = null;
      let partyMummy = null;
      const rosterReady = rosterDb.isReady();
      if (rosterReady) {
        try {
          [memberDoc, settings] = await Promise.all([
            rosterDb.getMember(targetUser.id),
            rosterDb.getSettings(),
          ]);
          power = await rosterDb.getPower(targetUser.id);
          if (memberDoc) {
            if (memberDoc.isMain) guilds.push('daddy');
            if (memberDoc.isSub) guilds.push('mummy');
          }
          if (guilds.includes('daddy')) partyDaddy = await resolveParty('daddy', targetUser.id);
          if (guilds.includes('mummy')) partyMummy = await resolveParty('mummy', targetUser.id);
        } catch (e) {
          console.warn('[profile] roster lookup failed:', e?.message || e);
        }
      }

      const onRoster = !!memberDoc;
      const className = memberDoc?.className || null;
      const role = className ? classToRole(className, settings?.classRoles) : null;

      // --- Build embed ------------------------------------------------------
      const color = role ? (ROLE_COLOR[role] ?? DEFAULT_COLOR) : DEFAULT_COLOR;

      const embed = new EmbedBuilder()
        .setTitle(`👤 ${displayName}`)
        .setColor(color)
        .setThumbnail(avatarURL)
        .setTimestamp();

      // Row: Class | Power | Guild(s)
      const classText = className
        ? `${className}${role ? ` (${ROLE_LABEL[role]}) ${ROLE_EMOJI[role]}` : ''}`
        : (rosterReady ? '—' : 'Roster unavailable');
      embed.addFields({ name: '🎭 Class', value: classText, inline: true });

      const powerText = power === null
        ? '—'
        : (power > 0 ? `⚡ ${power}` : 'Unrated');
      embed.addFields({ name: '💪 Power', value: powerText, inline: true });

      let guildText;
      if (!rosterReady) guildText = '—';
      else if (guilds.length === 2) guildText = '👑 Daddy + 💜 Mummy';
      else if (guilds.includes('daddy')) guildText = '👑 Daddy';
      else if (guilds.includes('mummy')) guildText = '💜 Mummy';
      else guildText = 'Not on a roster';
      embed.addFields({ name: '🏰 Guild(s)', value: guildText, inline: true });

      // Row: Kudos | Rank | Given today  (only if kudos available)
      if (kudos) {
        const rankText = kudos.total > 0 && kudos.rank
          ? `#${kudos.rank} of ${kudos.totalRecipients}`
          : 'Not ranked yet';
        embed.addFields(
          { name: '🙌 Kudos received', value: `${kudos.total}`, inline: true },
          { name: '🏅 Rank', value: rankText, inline: true },
          { name: '📤 Given today', value: `${kudos.givenToday}/${kudosDb.DAILY_LIMIT}`, inline: true },
        );
      }

      // Row: Joined | Account created | Status
      embed.addFields(
        { name: '📅 Joined server', value: tsLine(joinedMs) || 'Unknown', inline: true },
        { name: '🎂 Account created', value: tsLine(createdMs) || 'Unknown', inline: true },
      );
      let statusText;
      if (!inServer) statusText = '🔴 Left server';
      else if (onRoster) statusText = '🟢 Active';
      else statusText = '⚪ Not on roster';
      embed.addFields({ name: '📡 Status', value: statusText, inline: true });

      // Row: Party — Daddy | Party — Mummy
      if (partyDaddy) embed.addFields({ name: '⚔️ Party — Daddy', value: partyDaddy, inline: true });
      if (partyMummy) embed.addFields({ name: '⚔️ Party — Mummy', value: partyMummy, inline: true });

      // Not on either roster — explicit note.
      if (rosterReady && !onRoster) {
        embed.addFields({ name: '​', value: '_Not on the Daddy or Mummy roster._', inline: false });
      }

      // Roles (full width, capped).
      if (roleNames.length) {
        const shown = roleNames.slice(0, MAX_ROLES);
        const extra = roleNames.length - shown.length;
        const value = shown.join(', ') + (extra > 0 ? `, +${extra} more` : '');
        embed.addFields({ name: `🎚️ Roles (${roleNames.length})`, value: value.slice(0, 1024), inline: false });
      }

      embed.setFooter({ text: 'Give kudos with: kudos @member' });

      await interaction.editReply({ embeds: [embed] });
    } catch (err) {
      console.warn('[profile] Failed:', err?.message || err);
      await interaction.editReply("Couldn't load that profile right now — please try again in a moment.");
    }
  },
};
