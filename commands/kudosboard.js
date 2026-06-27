const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const db = require('../kudos/db');

// Singular/plural helper consistent with profile.js and messageCreate.js.
function kudosWord(n) {
  return n === 1 ? 'kudo' : 'kudos';
}

// Build a ranked list of lines from a topRecipients-shaped array.
// Returns an array of strings; empty array if rows is empty.
function buildRankedLines(rows) {
  return rows.map((row, i) =>
    `**${i + 1}.** <@${row.recipient_id}> — ${row.total} ${kudosWord(row.total)}`,
  );
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('kudosboard')
    .setDescription('Show the kudos leaderboard for this server.'),

  // Public (not ephemeral).
  async execute(interaction) {
    if (!db.isReady()) {
      await interaction.reply("Kudos system isn't configured yet — ask an admin.");
      return;
    }

    await interaction.deferReply(); // public

    try {
      const guildId = interaction.guild.id;

      // Fetch both boards in parallel.
      const [daily, allTime] = await Promise.all([
        db.topRecipientsToday(guildId, 10),
        db.topRecipients(guildId, 10),
      ]);

      // Whole-board empty state: both sections have nothing to show.
      if (daily.length === 0 && allTime.length === 0) {
        const empty = new EmbedBuilder()
          .setTitle('🏆 Kudos Leaderboard')
          .setColor(0xF1C40F)
          .setDescription("No kudos yet — thank someone with `kudos @member`!")
          .setTimestamp();
        await interaction.editReply({ embeds: [empty] });
        return;
      }

      // Build the daily section.
      const dailyLines = buildRankedLines(daily);
      const dailySection = dailyLines.length > 0
        ? dailyLines.join('\n')
        : '_No kudos yet today — be the first!_';

      // Build the all-time section.
      const allTimeLines = buildRankedLines(allTime);
      const allTimeSection = allTimeLines.length > 0
        ? allTimeLines.join('\n')
        : "_No kudos recorded yet — thank someone with `kudos @member`!_";

      // If the invoker isn't in the all-time top-10, append their rank.
      const invokerId = interaction.user.id;
      const inTop = allTime.some(r => r.recipient_id === invokerId);
      let yourRankLine = '';
      if (!inTop) {
        const { total, rank } = await db.rankForRecipient(guildId, invokerId);
        if (total > 0) {
          yourRankLine = `\n\nYou: **#${rank}** — ${total} ${kudosWord(total)}`;
        } else {
          yourRankLine = "\n\nYou: no kudos yet — earn some by being awesome!";
        }
      }

      const divider = '\n━━━━━━━━━━\n';

      const description =
        `🗓️ **Today**\n${dailySection}` +
        divider +
        `🏆 **All-Time**\n${allTimeSection}` +
        yourRankLine;

      const embed = new EmbedBuilder()
        .setTitle('🏆 Kudos Leaderboard')
        .setColor(0xF1C40F)
        .setDescription(description)
        .setFooter({ text: 'Give kudos with: kudos @member' })
        .setTimestamp();

      await interaction.editReply({ embeds: [embed] });
    } catch (err) {
      console.warn('[kudosboard] Query failed:', err?.message || err);
      await interaction.editReply("Couldn't load the kudos board right now — please try again in a moment.");
    }
  },
};
