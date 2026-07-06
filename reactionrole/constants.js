// ---------------------------------------------------------------------------
// Shared constants for the Guild Expedition reaction-role feature.
//
// /guildexpedition (Godfathers only) posts a PUBLIC embed; members react with
// REACTION_EMOJI to self-assign the Guild Expedition role and remove their
// reaction to drop it. The bot seeds its own reaction so joining is one click.
// Message registrations persist in Mongo (reactionrole/db.js) so reactions
// keep working across Railway restarts.
// ---------------------------------------------------------------------------

// Role allowed to run /guildexpedition — the Godfathers. The REACTION on the
// posted embed is usable by everyone; only the command is gated.
const GODFATHERS_ROLE_ID = '1518076150692188200';

// The role granted/removed when members add/remove the reaction.
const GUILD_EXPEDITION_ROLE_ID = '1523474517941289061';

// -------------------------------------------------------------------------
// The reaction emoji — Conrad: edit this one line to change it.
// Must be a UNICODE emoji (e.g. '✅', '🎉', '⚔️'). For a CUSTOM server emoji,
// use its numeric emoji ID string instead (e.g. '123456789012345678').
// Only affects embeds posted AFTER the change — already-posted embeds keep
// the emoji they were registered with.
// -------------------------------------------------------------------------
const REACTION_EMOJI = '✅';

// ---------------------------------------------------------------------------
// Editable copy — Conrad: reword freely, the code never parses these strings.
// {emoji} and {role} placeholders are substituted when the embed is built.
// ---------------------------------------------------------------------------
const EMBED_TITLE = '🗺️ Guild Expedition Sign-Up';
const EMBED_DESCRIPTION =
  'React with {emoji} below to receive the {role} role and join the ' +
  'Guild Expedition!\n\n' +
  'Remove your reaction at any time to drop the role.';
const EMBED_COLOR = 0x5865F2; // house blurple, matches /help

module.exports = {
  GODFATHERS_ROLE_ID,
  GUILD_EXPEDITION_ROLE_ID,
  REACTION_EMOJI,
  EMBED_TITLE,
  EMBED_DESCRIPTION,
  EMBED_COLOR,
};
