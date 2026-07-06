// ---------------------------------------------------------------------------
// /guildexpedition — post the Guild Expedition reaction-role embed
// (Godfathers only).
//
//   /guildexpedition [channel] — posts a PUBLIC embed inviting members to
//                                react ✅ to self-assign the Guild Expedition
//                                role (removing the reaction removes it).
//                                channel defaults to where it's run.
//
// The REACTION on the embed is open to everyone; only this command is
// role-gated. The bot seeds its own ✅ so joining is one click. Each posted
// embed is registered in reactionrole_messages (reactionrole/db.js) — the
// messageReactionAdd/Remove handlers work purely off that lookup, so the
// embed keeps working across Railway restarts. Graceful degrade — DB down
// means the command replies "unavailable" instead of posting a dead embed.
// ---------------------------------------------------------------------------

const {
  SlashCommandBuilder,
  EmbedBuilder,
  ChannelType,
  PermissionFlagsBits,
} = require('discord.js');
const db = require('../reactionrole/db');
const {
  GODFATHERS_ROLE_ID,
  GUILD_EXPEDITION_ROLE_ID,
  REACTION_EMOJI,
  EMBED_TITLE,
  EMBED_DESCRIPTION,
  EMBED_COLOR,
} = require('../reactionrole/constants');

// Returns true only if the member holds the Godfathers role.
function isGodfather(interaction) {
  const member = interaction.member;
  if (!member) return false;
  return Boolean(member.roles?.cache?.has?.(GODFATHERS_ROLE_ID));
}

// The sign-up embed. {emoji}/{role} placeholders come from constants so
// Conrad can reword the copy without touching code.
function buildEmbed() {
  const description = EMBED_DESCRIPTION
    .replaceAll('{emoji}', REACTION_EMOJI)
    .replaceAll('{role}', `<@&${GUILD_EXPEDITION_ROLE_ID}>`);
  return new EmbedBuilder()
    .setTitle(EMBED_TITLE)
    .setDescription(description)
    .setColor(EMBED_COLOR)
    .setTimestamp();
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('guildexpedition')
    .setDescription('Post the Guild Expedition sign-up embed — react to get the role (Godfathers only).')
    .addChannelOption(opt =>
      opt
        .setName('channel')
        .setDescription('Channel for the embed (defaults to this channel).')
        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
        .setRequired(false),
    ),

  async execute(interaction) {
    // Godfathers gate — ephemeral deny, nothing posted.
    if (!isGodfather(interaction)) {
      await interaction.reply({
        content: "Sorry — you don't have permission to use this command.",
        ephemeral: true,
      });
      return;
    }

    // Graceful degradation — without persistence the reaction handlers can't
    // find the message after a restart, so don't post a dead embed at all.
    if (!db.isReady()) {
      await interaction.reply({
        content: '⚠️ Guild Expedition sign-up is unavailable right now (database not reachable). Please try again later.',
        ephemeral: true,
      });
      return;
    }

    const channel = interaction.options.getChannel('channel') ?? interaction.channel;

    if (!channel?.isTextBased?.() || !interaction.guild) {
      await interaction.reply({
        content: '⚠️ Pick a text channel I can post in.',
        ephemeral: true,
      });
      return;
    }

    // Check the bot can actually post + react there before posting anything.
    const me = interaction.guild.members.me;
    const perms = me ? channel.permissionsFor(me) : null;
    if (
      perms &&
      !(
        perms.has(PermissionFlagsBits.ViewChannel) &&
        perms.has(PermissionFlagsBits.SendMessages) &&
        perms.has(PermissionFlagsBits.EmbedLinks) &&
        perms.has(PermissionFlagsBits.AddReactions)
      )
    ) {
      await interaction.reply({
        content: `⚠️ I can't set that up in ${channel} — I need **View Channel**, **Send Messages**, **Embed Links**, and **Add Reactions** there.`,
        ephemeral: true,
      });
      return;
    }

    await interaction.deferReply({ ephemeral: true });

    // Post the public embed.
    let message;
    try {
      message = await channel.send({ embeds: [buildEmbed()] });
    } catch (err) {
      console.warn('[guildexpedition] Failed to post embed:', err?.message || err);
      await interaction.editReply(`⚠️ Couldn't post the embed in ${channel} — check my permissions there.`);
      return;
    }

    // Register FIRST (source of truth for the reaction handlers), then seed.
    // If registration fails, the embed would never grant roles — remove it
    // rather than leave a dead sign-up in the channel.
    try {
      await db.registerMessage({
        messageId: message.id,
        channelId: channel.id,
        guildId: interaction.guild.id,
        emoji: REACTION_EMOJI,
        roleId: GUILD_EXPEDITION_ROLE_ID,
      });
    } catch (err) {
      console.warn('[guildexpedition] Failed to persist registration:', err?.message || err);
      try { await message.delete(); } catch { /* best effort */ }
      await interaction.editReply('⚠️ Database error while saving the sign-up — nothing was posted. Please try again.');
      return;
    }

    // Seed the bot's own reaction so members can one-click it. Non-fatal —
    // the embed still works if members add the first reaction themselves.
    let seeded = true;
    try {
      await message.react(REACTION_EMOJI);
    } catch (err) {
      seeded = false;
      console.warn('[guildexpedition] Failed to seed reaction:', err?.message || err);
    }

    await interaction.editReply(
      `✅ Guild Expedition sign-up posted in ${channel} — members react ${REACTION_EMOJI} to get <@&${GUILD_EXPEDITION_ROLE_ID}>.` +
      (seeded ? '' : `\n⚠️ I couldn't add the seed ${REACTION_EMOJI} reaction — check my **Add Reactions** permission (members can still react manually).`),
    );
  },
};
