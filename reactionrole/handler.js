// ---------------------------------------------------------------------------
// Reaction-role core — shared by events/messageReactionAdd.js and
// events/messageReactionRemove.js.
//
// Flow (restart-safe — NO in-memory state):
//   1. Fetch partials FIRST (reaction / message / user can all arrive partial
//      for messages posted before the current process started — that's the
//      whole point of Partials.Reaction + Partials.Message in index.js).
//   2. Ignore bot reactions (including the bot's own seeded ✅).
//   3. Look the message up in reactionrole_messages. Not registered → not one
//      of ours → ignore. This DB lookup is the ONLY source of truth, so
//      reactions on embeds posted before a Railway restart still work.
//   4. Emoji must match the one the embed was registered with.
//   5. Add/remove the registered role on the member.
//
// NEVER throws — a reaction-role failure must not crash the client or bleed
// into kudos/GvG/campaign handlers. Everything is wrapped; errors are logged
// and swallowed.
// ---------------------------------------------------------------------------

const db = require('./db');

// The key a reaction matches on: custom emojis match by id, unicode by name.
// Registrations store whichever form REACTION_EMOJI was at post time.
function emojiKey(emoji) {
  return emoji?.id ?? emoji?.name ?? null;
}

/**
 * Handle a reaction add/remove.
 * @param {MessageReaction|PartialMessageReaction} reaction
 * @param {User|PartialUser} user - the reacting user
 * @param {'add'|'remove'} action
 */
async function handleReaction(reaction, user, action) {
  try {
    // -- 1. Resolve partials BEFORE any logic ------------------------------
    // A reaction on a message from before this process started arrives
    // partial; fetch() hydrates it (and its message shell). If the message
    // was deleted meanwhile, fetch() throws → caught below → no-op.
    if (reaction.partial) {
      reaction = await reaction.fetch();
    }
    let message = reaction.message;
    if (message?.partial) {
      message = await message.fetch();
    }
    if (user?.partial) {
      user = await user.fetch();
    }
    if (!message || !message.guild) return; // DMs / nothing to act on

    // -- 2. Ignore bots (including our own seeded reaction) ----------------
    if (user?.bot) return;

    // -- 3. Registered message? (sole source of truth — restart-safe) ------
    if (!db.isReady()) return; // graceful degrade: DB down → reaction is inert
    const doc = await db.getMessage(message.id);
    if (!doc) return; // not a reaction-role message

    // -- 4. Emoji match -----------------------------------------------------
    if (emojiKey(reaction.emoji) !== doc.emoji) return;

    // -- 5. Toggle the role --------------------------------------------------
    const member =
      message.guild.members.cache.get(user.id) ??
      (await message.guild.members.fetch(user.id));
    if (!member) return;

    if (action === 'add') {
      await member.roles.add(doc.roleId, 'Guild Expedition reaction role (reacted)');
    } else {
      await member.roles.remove(doc.roleId, 'Guild Expedition reaction role (reaction removed)');
    }
  } catch (err) {
    // Missing Manage Roles, role above the bot, deleted message/user, API
    // hiccup — log and move on. Never propagate.
    console.warn(`[reactionrole] ${action} handler error:`, err?.message || err);
  }
}

module.exports = { handleReaction, emojiKey };
