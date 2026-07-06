// ---------------------------------------------------------------------------
// messageReactionAdd — feeds the Guild Expedition reaction-role feature.
//
// Fires on every reaction added in the guild (needs the GuildMessageReactions
// intent + Partials.Reaction — added in index.js so reactions on messages
// posted before a restart still emit). Delegates to reactionrole/handler.js,
// which fetches partials first, ignores bots, and only acts on messages
// registered in reactionrole_messages. Errors never propagate — a reaction
// failure must not crash the client.
// ---------------------------------------------------------------------------

const { Events } = require('discord.js');
const { handleReaction } = require('../reactionrole/handler');

module.exports = {
  name: Events.MessageReactionAdd,
  once: false,
  async execute(reaction, user) {
    await handleReaction(reaction, user, 'add'); // never throws
  },
};
