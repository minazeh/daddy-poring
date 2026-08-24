const { Events } = require('discord.js');
const guildapp = require('../guildapp/handlers');
const officerapp = require('../officerapp/handlers');
const partyfinder = require('../partyfinder/handlers');
const carry = require('../carry/handlers');
const quiz = require('../quiz/handlers');
const activitycampaign = require('../activitycampaign/handlers');
const gvgReminder = require('../gvg/reminder');
const monsterquiz = require('../monsterquiz/engine');
const ticket = require('../ticket/handlers');
const petition = require('../petition/handlers');
const stickymessage = require('../sticky/handlers');

module.exports = {
  name: Events.InteractionCreate,
  once: false,
  async execute(interaction) {
    try {
      // ----------------------------------------------------------------------
      // Autocomplete (rodb /monster /item /card /map name options — any
      // command may opt in by exporting an `autocomplete(interaction)`).
      // Handled FIRST: Discord gives autocomplete a hard 3 s window, and this
      // interaction type is neither a component nor a chat command, so the
      // routers below must never see it. Self-contained error handling —
      // autocomplete can only be answered with respond(), never reply(), so
      // the generic catch at the bottom doesn't apply. Unknown command or no
      // handler → respond with an empty list, never throw.
      // ----------------------------------------------------------------------
      if (interaction.isAutocomplete()) {
        const command = interaction.client.commands.get(interaction.commandName);
        try {
          if (command?.autocomplete) {
            await command.autocomplete(interaction);
          } else {
            await interaction.respond([]);
          }
        } catch (err) {
          console.warn('[interactionCreate] Autocomplete error:', err?.message || err);
          if (!interaction.responded) {
            try { await interaction.respond([]); } catch { /* window expired — ignore */ }
          }
        }
        return;
      }

      // ----------------------------------------------------------------------
      // Guild application feature: buttons (guildapp:start, appreview:*) and
      // modal submit (guildapp:modal). route() returns true if
      // it owned the interaction.
      // ----------------------------------------------------------------------
      if (interaction.isButton() || interaction.isModalSubmit() || interaction.isStringSelectMenu()) {
        // Carry sales (Final Mirage): carry:pick panel button, carry:tier /
        // carry:run / carry:pay selects, the carry:ign modal, the carry:priest
        // declaration button, and the officer carry:paid/release/cancel
        // buttons. route() claims ONLY the `carry:` namespace and returns false
        // for everything else, so it is safe ahead of the routers below.
        // Routed first because it is the live sales flow; /partyfinder below is
        // retired (its command is no longer registered) and its module is kept
        // only so already-posted cards keep resolving.
        const carryHandled = await carry.route(interaction);
        if (carryHandled) return;

        // Party Finder feature (RETIRED — /partyfinder is no longer registered;
        // see lib/registerCommands.js. The module stays so any card posted
        // before the retirement still resolves its buttons): partyfinder:start/
        // carry entry buttons, pf:size select, pf:details/roles/carrydetails
        // modals, and the pf:rolesopen/join/cancel/carryrespond/carrycancel
        // buttons.
        const partyHandled = await partyfinder.route(interaction);
        if (partyHandled) return;

        // Class Quiz feature: answer buttons (quiz:answer:<LETTER>). The quiz:*
        // namespace is unique, so this won't collide with the routers below.
        const quizHandled = await quiz.route(interaction);
        if (quizHandled) return;

        // Activity campaign: sticky-prompt answer buttons
        // (activitycampaign:yes / activitycampaign:no). Static customIds —
        // restart-safe, unique namespace, no collision with other routers.
        const campaignHandled = await activitycampaign.route(interaction);
        if (campaignHandled) return;

        // Guild Event reminder RSVP buttons (gvgrsvp:<yes|no>:<occurrenceKey>).
        // Unique namespace — no collision with the routers around it.
        const gvgRsvpHandled = await gvgReminder.route(interaction);
        if (gvgRsvpHandled) return;

        // Monster Quiz: the category select menu (monsterquiz:category) AND the
        // signup Join button (monsterquiz:join) — route() dispatches on customId
        // and claims both. Unique namespace, no collision with the routers around
        // it (partyfinder above returns false for foreign select menus). Acks with
        // deferUpdate() (silent — posts no message).
        const monsterQuizHandled = await monsterquiz.route(interaction);
        if (monsterQuizHandled) return;

        // Job-ad -> officer-application feature: jobad:modal, jobapply:<id>,
        // officerapp:modal:<id>, officerreview:daddy|mummy|reject:<userId>:<id>.
        // Routed before the guild-app router so its customIds are claimed first.
        const officerHandled = await officerapp.route(interaction);
        if (officerHandled) return;

        // Support tickets: ticket:open, ticket:modal, ticket:accept|decline|
        // resolve:<ticketId>, ticket:declinemodal:<ticketId>. route() claims
        // only the `ticket:` namespace, which nothing else uses. Every id but
        // the panel button carries the ticket id, so these stay actionable
        // across restarts with no in-memory state.
        const ticketHandled = await ticket.route(interaction);
        if (ticketHandled) return;

        // Petition: petition:sign, petition:modal. Both static customIds,
        // unique namespace, no state behind them — a posted panel works
        // forever across restarts.
        const petitionHandled = await petition.route(interaction);
        if (petitionHandled) return;

        // Sticky messages: sticky:modal:<set|edit>:<channelId> — the ONLY
        // interaction this feature owns. route() claims nothing but the
        // `sticky:` namespace, which no other router uses. The target channel
        // rides in the customId, so a modal opened before a redeploy and
        // submitted after it still lands in the right channel.
        const stickyHandled = await stickymessage.route(interaction);
        if (stickyHandled) return;

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
