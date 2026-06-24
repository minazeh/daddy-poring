const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const db = require('../kudos/db');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('kudosboard')
    .setDescription('Show the kudos leaderboard for this server.'),

  // Public (not ephemeral).
  async execute(interaction) {
    if (!db.isReady()) {
      await interaction.reply('Kudos system isn’t configured yet — ask an admin.');
      return;
    }

    await interaction.deferReply(); // public

    try {
      const guildId = interaction.guild.id;
      const top = await db.topRecipients(guildId, 15);

      if (top.length === 0) {
        const empty = new EmbedBuilder()
          .setTitle('🏆 Kudos Leaderboard')
          .setColor(0xF1C40F)
          .setDescription("No kudos yet — thank someone with `kudos @member`!")
          .setTimestamp();
        await interaction.editReply({ embeds: [empty] });
        return;
      }

      const lines = top.map((row, i) =>
        `**${i + 1}.** <@${row.recipient_id}> — ${row.total} ${row.total === 1 ? 'kudo' : 'kudos'}`,
      );

      // If the invoker isn't in the top 15, append their own rank.
      const invokerId = interaction.user.id;
      const inTop = top.some(r => r.recipient_id === invokerId);
      let footerLine = '';
      if (!inTop) {
        const { total, rank } = await db.rankForRecipient(guildId, invokerId);
        if (total > 0) {
          footerLine = `\n\nYou: **#${rank}** — ${total} ${total === 1 ? 'kudo' : 'kudos'}`;
        } else {
          footerLine = "\n\nYou: no kudos yet — earn some by being awesome!";
        }
      }

      const embed = new EmbedBuilder()
        .setTitle('🏆 Kudos Leaderboard')
        .setColor(0xF1C40F)
        .setDescription(lines.join('\n') + footerLine)
        .setFooter({ text: 'Give kudos with: kudos @member' })
        .setTimestamp();

      await interaction.editReply({ embeds: [embed] });
    } catch (err) {
      console.warn('[kudosboard] Query failed:', err?.message || err);
      await interaction.editReply('Couldn’t load the kudos board right now — please try again in a moment.');
    }
  },
};
