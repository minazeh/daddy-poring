const { Events } = require('discord.js');
const guildapp = require('../guildapp/handlers');

module.exports = {
  name: Events.InteractionCreate,
  once: false,
  async execute(interaction) {
    try {
      // ----------------------------------------------------------------------
      // Guild application feature: buttons (guildapp:start, appapprove:*,
      // appdeny:*) and modal submit (guildapp:modal). route() returns true if
      // it owned the interaction.
      // ----------------------------------------------------------------------
      if (interaction.isButton() || interaction.isModalSubmit()) {
        const handled = await guildapp.route(interaction);
        if (handled) return;
        // Unrecognised component/modal — ignore silently (could belong to a
        // future feature). Do not error out.
        return;
      }

      // ----------------------------------------------------------------------
      // Slash commands (dynamic loader). Keep /ping and friends working.
      // ----------------------------------------------------------------------
      if (!interaction.isChatInputCommand()) return;

      const command = interaction.client.commands.get(interaction.commandName);
      if (!command) {
        console.error(`[interactionCreate] No command matching "${interaction.commandName}" found.`);
        return;
      }

      await command.execute(interaction);
    } catch (error) {
      console.error('[interactionCreate] Handler error:', error);

      const reply = { content: 'There was an error processing that interaction.', ephemeral: true };
      try {
        if (interaction.isRepliable()) {
          if (interaction.replied || interaction.deferred) {
            await interaction.followUp(reply);
          } else {
            await interaction.reply(reply);
          }
        }
      } catch (e) {
        console.error('[interactionCreate] Failed to send error reply:', e?.message || e);
      }
    }
  },
};
