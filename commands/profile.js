const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const db = require('../kudos/db');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('profile')
    .setDescription('Show a member\'s kudos profile (defaults to you).')
    .addUserOption(option =>
      option
        .setName('user')
        .setDescription('Whose profile to view (defaults to you).')
        .setRequired(false),
    ),

  // Public (not ephemeral).
  async execute(interaction) {
    if (!db.isReady()) {
      await interaction.reply('Kudos system isn’t configured yet — ask an admin.');
      return;
    }

    await interaction.deferReply(); // public

    try {
      const guildId = interaction.guild.id;
      const targetUser = interaction.options.getUser('user') ?? interaction.user;

      // Resolve a member for display name + avatar (fall back to the user).
      let displayName = targetUser.username;
      let avatarURL = targetUser.displayAvatarURL();
      try {
        const member = await interaction.guild.members.fetch(targetUser.id);
        displayName = member.displayName;
        avatarURL = member.displayAvatarURL();
      } catch {
        // Not a member (left guild) — use the user's global identity.
      }

      const { total, rank, totalRecipients } = await db.rankForRecipient(guildId, targetUser.id);
      const givenToday = await db.countGivenToday(targetUser.id);

      const rankText = total > 0 && rank
        ? `#${rank} of ${totalRecipients} ${totalRecipients === 1 ? 'recipient' : 'recipients'}`
        : 'Not ranked yet';

      const embed = new EmbedBuilder()
        .setTitle(`✨ Kudos Profile — ${displayName}`)
        .setColor(0x5865F2)
        .setThumbnail(avatarURL)
        .addFields(
          { name: '🙌 Kudos received', value: `${total}`, inline: true },
          { name: '🏅 Rank',           value: rankText, inline: true },
          { name: '📤 Given today',    value: `${givenToday}/${db.DAILY_LIMIT}`, inline: true },
        )
        .setFooter({ text: 'Give kudos with: kudos @member' })
        .setTimestamp();

      await interaction.editReply({ embeds: [embed] });
    } catch (err) {
      console.warn('[profile] Query failed:', err?.message || err);
      await interaction.editReply('Couldn’t load that profile right now — please try again in a moment.');
    }
  },
};
