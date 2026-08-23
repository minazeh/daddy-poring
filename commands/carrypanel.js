// ---------------------------------------------------------------------------
// /carrypanel — post the Final Mirage carry sales panel (Godfathers only).
//
// Spec: docs/CARRY_SYSTEM_SPEC.md §7.1
//
// The panel is posted ONCE to the sales-panel channel and is STATIC: it holds
// no state, so it keeps working across every Railway redeploy. Same shape as
// /guildapplication and /guildsupport — an embed plus one button.
// ---------------------------------------------------------------------------

const { SlashCommandBuilder, MessageFlags } = require('discord.js');

const db = require('../carry/db');
const handlers = require('../carry/handlers');
const { CHANNELS } = require('../carry/constants');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('carrypanel')
    .setDescription('Post the Final Mirage carry sales panel (Godfathers only).'),

  async execute(interaction) {
    if (!handlers.isGodfather(interaction)) {
      await interaction.reply({
        content: "Sorry — you don't have permission to use this command.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    // The panel itself is stateless, but the button behind it needs the store.
    // Posting a panel that can't sell anything is worse than saying so.
    if (!db.isReady()) {
      await interaction.reply({
        content: '⚠️ Carry sales are unavailable right now (database not reachable), so the panel would not work. Try again once the store is back.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    try {
      const channel = await interaction.client.channels.fetch(CHANNELS.PANEL);
      const posted = await channel.send({
        embeds: [handlers.buildPanelEmbed()],
        components: handlers.buildPanelComponents(),
      });
      await interaction.editReply(
        `✅ Carry sales panel posted in <#${channel.id}>.\n` +
        `${posted.url}\n\n` +
        'It is static — it will keep working after every restart. Post it once; ' +
        'if you post another, both stay live and buyers can use either.',
      );
    } catch (err) {
      console.warn('[carrypanel] Could not post the panel:', err?.message || err);
      await interaction.editReply(
        `⚠️ Couldn't post the panel to <#${CHANNELS.PANEL}> — check the channel id and that ` +
        'the bot can send messages there.',
      );
    }
  },
};
