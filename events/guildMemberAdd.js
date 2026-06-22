const { Events, EmbedBuilder } = require('discord.js');

// ---------------------------------------------------------------------------
// Channel IDs — edit here if channels are ever renamed/moved.
// ---------------------------------------------------------------------------
const WELCOME_CHANNEL_ID             = '1518655237815144538'; // #welcome (destination)
const RULES_CHANNEL_ID               = '1518072757928067194'; // #rules
const APPLICATION_INFO_CHANNEL_ID    = '1518226579657064577'; // #application-info
const ATTENTION_APPLICANTS_CHANNEL_ID = '1518609010562044075'; // #attention-applicants (Valor CBT)

module.exports = {
  name: Events.GuildMemberAdd,

  async execute(member) {
    // Ignore bots.
    if (member.user.bot) return;

    // Fetch the welcome channel.
    let channel;
    try {
      channel = await member.guild.channels.fetch(WELCOME_CHANNEL_ID);
    } catch (err) {
      console.warn(`[guildMemberAdd] Could not fetch welcome channel ${WELCOME_CHANNEL_ID}:`, err?.message || err);
      return;
    }

    if (!channel || !channel.isTextBased()) {
      console.warn(`[guildMemberAdd] Welcome channel ${WELCOME_CHANNEL_ID} not found or is not text-based.`);
      return;
    }

    const embed = new EmbedBuilder()
      .setColor(0x2b2d31)
      .setAuthor({
        name: `Welcome ${member.displayName}`,
        iconURL: member.displayAvatarURL(),
      })
      .setThumbnail(member.displayAvatarURL())
      .setDescription(
        `**Please follow the onboarding steps**\n\n` +
        `1. Read our <#${RULES_CHANNEL_ID}>\n` +
        `2. Change your server nickname to your IGN.\n` +
        `3. Fill out your application in <#${APPLICATION_INFO_CHANNEL_ID}>\n` +
        `4. Wait for leadership to approve your application.\n\n` +
        `Thank you~\n\n` +
        `If you are from Valor CBT, please fill out the form in <#${ATTENTION_APPLICANTS_CHANNEL_ID}>.`
      )
      .setFooter({
        text: member.guild.name,
        iconURL: member.guild.iconURL() ?? undefined,
      });

    try {
      await channel.send({ embeds: [embed] });
    } catch (err) {
      console.warn('[guildMemberAdd] Failed to send welcome embed (check Send Messages / Embed Links perms):', err?.message || err);
    }
  },
};
