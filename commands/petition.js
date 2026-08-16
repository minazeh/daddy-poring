// ---------------------------------------------------------------------------
// /petition — post the Solar petition panel with a Sign button.
//
// Godfathers only: the panel signs off as "All the Godfathers", so it should
// only be postable by one. Same gate as /guildsupport and /activitycampaign.
//
// The button's customId is static, so the posted panel keeps working across
// restarts and redeploys forever — there is no state behind it.
// ---------------------------------------------------------------------------

const {
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
} = require('discord.js');

const {
  IDS,
  GODFATHERS_ROLE_ID,
  COLORS,
  PANEL_TITLE,
  PANEL_BUTTON_LABEL,
  PANEL_BODY,
} = require('../petition/constants');

function isGodfather(interaction) {
  const member = interaction.member;
  if (!member) return false;
  return Boolean(member.roles?.cache?.has?.(GODFATHERS_ROLE_ID));
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('petition')
    .setDescription('Post the petition for Solar\'s return, with a Sign button (Godfathers only).'),

  async execute(interaction) {
    if (!isGodfather(interaction)) {
      await interaction.reply({
        content: 'Only Godfathers can post the petition.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const embed = new EmbedBuilder()
      .setTitle(PANEL_TITLE)
      .setDescription(PANEL_BODY)
      .setColor(COLORS.PANEL);

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(IDS.SIGN_BUTTON)
        .setLabel(PANEL_BUTTON_LABEL)
        .setStyle(ButtonStyle.Success),
    );

    await interaction.reply({ embeds: [embed], components: [row] });
  },
};
