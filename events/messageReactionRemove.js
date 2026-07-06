// ---------------------------------------------------------------------------
// messageReactionRemove — the un-react side of the Guild Expedition
// reaction-role feature: removing your ✅ removes the role.
//
// Same shape as messageReactionAdd.js — see that file and
// reactionrole/handler.js for the full flow. Errors never propagate.
// ---------------------------------------------------------------------------

const { Events } = require('discord.js');
const { handleReaction } = require('../reactionrole/handler');

module.exports = {
  name: Events.MessageReactionRemove,
  once: false,
  async execute(reaction, user) {
    await handleReaction(reaction, user, 'remove'); // never throws
  },
};
