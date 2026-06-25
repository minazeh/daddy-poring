const { SlashCommandBuilder } = require('discord.js');
const db = require('../quiz/db');
const { buildLeaderboardEmbed } = require('../quiz/handlers');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('qna')
    .setDescription('Show the top 10 quiz scorers.'),

  // PUBLIC (not ephemeral) — mirrors the source /qna.
  async execute(interaction) {
    if (!db.isReady()) {
      await interaction.reply('The quiz isn’t configured yet — ask an admin.');
      return;
    }

    await interaction.deferReply(); // public
    try {
      const rows = await db.getLeaderboard(10);
      const embed = buildLeaderboardEmbed(rows);
      await interaction.editReply({ embeds: [embed] });
    } catch (err) {
      console.warn('[qna] Query failed:', err?.message || err);
      await interaction.editReply('Couldn’t load the quiz standings right now — please try again in a moment.');
    }
  },
};
