const { Events } = require('discord.js');
const guildapp = require('../guildapp/handlers');
const officerapp = require('../officerapp/handlers');

module.exports = {
  name: Events.InteractionCreate,
  once: false,
  async execute(interaction) {
    try {
      // ----------------------------------------------------------------------
      // Guild application feature: buttons (guildapp:start, appreview:*) and
      // modal submit (guildapp:modal). route() returns true if
      // it owned the interaction.
      // ----------------------------------------------------------------------
      if (interaction.isButton() || interaction.isModalSubmit()) {
        // Job-ad -> officer-application feature: jobad:modal, jobapply:<id>,
        // officerapp:modal:<id>, officerreview:daddy|mummy|reject:<userId>:<id>.
        // Routed first so its customIds are claimed before the guild-app router.
        const officerHandled = await officerapp.route(interaction);
        if (officerHandled) return;

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
