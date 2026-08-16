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
  panelDescription,
  hasUnfilledFormLink,
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
      .setDescription(panelDescription())
      .setColor(COLORS.PANEL);

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(IDS.SIGN_BUTTON)
        .setLabel(PANEL_BUTTON_LABEL)
        .setStyle(ButtonStyle.Success),
    );

    await interaction.reply({ embeds: [embed], components: [row] });

    // The form URL was never supplied, so the body still reads "(paste link)".
    // Say so straight after posting rather than letting it go out unnoticed —
    // this is a one-shot announcement and a dead placeholder in it is
    // embarrassing in a way a normal bug is not.
    if (hasUnfilledFormLink()) {
      await interaction.followUp({
        content:
          '⚠️ Heads up: the panel still says **"Form is here (paste link)"** — no form URL was ' +
          'set. Set `FORM_URL` in `petition/constants.js`, redeploy, then delete this panel and ' +
          're-run `/petition`.',
        flags: MessageFlags.Ephemeral,
      });
    }
  },
};
