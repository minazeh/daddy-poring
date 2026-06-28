const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const kudosDb = require('../kudos/db');
const rosterDb = require('../roster/db');
const { classToRole, ROLE_EMOJI } = require('../roster/roles');

// Role-based accent colors (match the roster image badges).
const ROLE_COLOR = { tank: 0x3b82f6, healer: 0x22c55e, dps: 0xf97316 };
const DEFAULT_COLOR = 0x5865f2;

// Zero-width char for invisible spacer fields.
const ZWS = '​';
const SPACER_INLINE = { name: ZWS, value: ZWS, inline: true };
const SPACER_FULL = { name: ZWS, value: ZWS, inline: false };

// Build a full-width Raid/Party/members field for one guild. Field NAME = the
// raid (raid on top); VALUE = party name + members, owner highlighted.
// guildEmoji prefixes the raid name only when the member is in BOTH guilds.
// Read-only; never throws to the caller.
async function buildPartyField(guild, userId, settings, guildEmoji) {
  const prefix = guildEmoji ? `${guildEmoji} ` : '';
  try {
    const [members, parties, raids] = await Promise.all([
      rosterDb.getMembers(guild),
      rosterDb.getParties(guild),
      rosterDb.getRaidGroups(guild),
    ]);
    const party = parties.find(p => (p.memberIds || []).includes(userId));
    if (!party) {
      return { name: `${prefix}⚔️ Party`, value: 'Not in a party', inline: false };
    }

    const memberMap = new Map(members.map(m => [m.userId, m]));
    const raid = raids.find(r => (r.partyIds || []).includes(party.partyId));
    const raidName = raid ? raid.name : 'Unassigned';

    const lines = [`👥 **Party:** ${party.name}`, '**Party members:**'];
    for (const id of party.memberIds || []) {
      const m = memberMap.get(id);
      const cls = m?.className || null;
      const icon = ROLE_EMOJI[classToRole(cls, settings?.classRoles)] || ROLE_EMOJI.dps;
      const name = m?.displayName || m?.username || 'Unknown';
      const label = id === userId ? `**▶ ${name}**` : name;
      lines.push(`${icon} ${label} (${cls || 'No class'})`);
    }

    let value = lines.join('\n');
    if (value.length > 1024) value = `${value.slice(0, 1021)}…`;
    return { name: `${prefix}⚔️ Raid: ${raidName}`, value, inline: false };
  } catch {
    return { name: `${prefix}⚔️ Party`, value: '—', inline: false };
  }
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

  // Public (not ephemeral). Everyone can use it. Degrades per-source.
  async execute(interaction) {
    await interaction.deferReply(); // public

    try {
      const guildId = interaction.guild?.id;
      const targetUser = interaction.options.getUser('user') ?? interaction.user;

      // --- Discord natives (with left-guild fetch fallback) -----------------
      let displayName = targetUser.globalName || targetUser.username;
      let avatarURL = targetUser.displayAvatarURL();
      let inServer = false;
      try {
        const member = await interaction.guild.members.fetch(targetUser.id);
        inServer = true;
        displayName = member.displayName;
        avatarURL = member.displayAvatarURL();
      } catch {
        // Left the server — use the user's global identity.
      }

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

      // --- Roster / class / power / guild membership (graceful if disabled) -
      let memberDoc = null;
      let settings = null;
      let power = null; // null = couldn't read; number = rating (0 = unrated)
      const guilds = []; // 'daddy' and/or 'mummy'
      const rosterReady = rosterDb.isReady();
      if (rosterReady) {
        try {
          [memberDoc, settings] = await Promise.all([
            rosterDb.getMember(targetUser.id),
            rosterDb.getSettings(),
          ]);
          power = await rosterDb.getPower(targetUser.id);
          if (memberDoc?.isMain) guilds.push('daddy');
          if (memberDoc?.isSub) guilds.push('mummy');
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

      // --- Summary stats as inline column fields (2-per-row via spacer) -----
      // Row 1: Class | Power | spacer
      const classEmoji = className ? (ROLE_EMOJI[role] || '❔') : '❔';
      const powerText = power && power > 0 ? `${power}` : 'Unrated';
      embed.addFields(
        { name: `${classEmoji} Class`, value: className || 'No class', inline: true },
        { name: '⚡ Power', value: powerText, inline: true },
        SPACER_INLINE,
      );

      // Row 2: Guild | Status | spacer
      let guildValue;
      if (guilds.length === 2) guildValue = 'Daddy + Mummy';
      else if (guilds.includes('daddy')) guildValue = 'Daddy';
      else if (guilds.includes('mummy')) guildValue = 'Mummy';
      else guildValue = 'Not on a roster';
      let statusValue;
      if (!inServer) statusValue = '🔴 Left server';
      else if (onRoster) statusValue = '🟢 Active';
      else statusValue = '⚪ Not on roster';
      embed.addFields(
        { name: '🏰 Guild', value: guildValue, inline: true },
        { name: '📡 Status', value: statusValue, inline: true },
        SPACER_INLINE,
      );

      // Row 3: Kudos | Rank | Today (natural 3-col) — only if kudos available
      if (kudos) {
        const rankValue = kudos.total > 0 && kudos.rank
          ? `#${kudos.rank} of ${kudos.totalRecipients}`
          : 'Unranked';
        embed.addFields(
          { name: '🙌 Kudos', value: `${kudos.total} received`, inline: true },
          { name: '🏅 Rank', value: rankValue, inline: true },
          { name: '📤 Today', value: `${kudos.givenToday}/${kudosDb.DAILY_LIMIT}`, inline: true },
        );
      }

      // Breathing room before the party block(s).
      embed.addFields(SPACER_FULL);

      // --- Party/raid block(s): full-width fields, raid on top -------------
      const bothGuilds = guilds.length === 2;
      if (guilds.includes('daddy')) {
        embed.addFields(await buildPartyField('daddy', targetUser.id, settings, bothGuilds ? '👑' : null));
      }
      if (guilds.includes('mummy')) {
        embed.addFields(await buildPartyField('mummy', targetUser.id, settings, bothGuilds ? '💜' : null));
      }

      await interaction.editReply({ embeds: [embed] });
    } catch (err) {
      console.warn('[profile] Failed:', err?.message || err);
      await interaction.editReply("Couldn't load that profile right now — please try again in a moment.");
    }
  },
};
