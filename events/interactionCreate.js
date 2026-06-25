const { Events } = require('discord.js');
const guildapp = require('../guildapp/handlers');
const officerapp = require('../officerapp/handlers');
const partyfinder = require('../partyfinder/handlers');
const quiz = require('../quiz/handlers');

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
      if (interaction.isButton() || interaction.isModalSubmit() || interaction.isStringSelectMenu()) {
        // Party Finder feature: partyfinder:start/carry entry buttons, pf:size
        // select, pf:details/roles/carrydetails modals, and the pf:rolesopen/
        // join/cancel/carryrespond/carrycancel buttons. Routed first so its
        // customIds (and the only select-menu in the bot) are claimed.
        const partyHandled = await partyfinder.route(interaction);
        if (partyHandled) return;

        // Class Quiz feature: answer buttons (quiz:answer:<LETTER>). The quiz:*
        // namespace is unique, so this won't collide with the routers below.
        const quizHandled = await quiz.route(interaction);
        if (quizHandled) return;

        // Job-ad -> officer-application feature: jobad:modal, jobapply:<id>,
        // officerapp:modal:<id>, officerreview:daddy|mummy|reject:<userId>:<id>.
        // Routed before the guild-app router so its customIds are claimed first.
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
