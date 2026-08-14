// ---------------------------------------------------------------------------
// /guildsupport — post the support-ticket panel (Godfathers only).
//
// The panel is fire-and-forget: post it once in the support channel and leave
// it. Its button uses a STATIC customId (`ticket:open`), so it keeps working
// forever — across restarts and redeploys — because nothing about it is held
// in memory.
// ---------------------------------------------------------------------------

const {
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
} = require('discord.js');

const db = require('../ticket/db');
const {
  IDS,
  GODFATHERS_ROLE_ID,
  COLORS,
  PANEL_TITLE,
  PANEL_DESCRIPTION,
  PANEL_BUTTON_LABEL,
} = require('../ticket/constants');

// Returns true only if the member holds the Godfathers role.
function isGodfather(interaction) {
  const member = interaction.member;
  if (!member) return false;
  return Boolean(member.roles?.cache?.has?.(GODFATHERS_ROLE_ID));
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('guildsupport')
    .setDescription('Post the support-ticket panel with an Open Ticket button (Godfathers only).'),

  async execute(interaction) {
    if (!isGodfather(interaction)) {
      await interaction.reply({
        content: 'Only Godfathers can post the support panel.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    // Warn rather than refuse: the panel is still worth posting, but the
    // button will politely decline until the store is reachable.
    if (!db.isReady()) {
      await interaction.reply({
        content:
          "⚠️ The ticket store isn't connected (check `MONGODB_URI` / Atlas Network Access). " +
          'The panel can still be posted, but Open Ticket will reply "unavailable" until it is back.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const embed = new EmbedBuilder()
      .setTitle(PANEL_TITLE)
      .setDescription(PANEL_DESCRIPTION)
      .setColor(COLORS.PANEL);

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(IDS.OPEN_BUTTON)
        .setLabel(PANEL_BUTTON_LABEL)
        .setStyle(ButtonStyle.Danger),
    );

    // Posted publicly in the channel; the button is clickable by anyone.
    await interaction.reply({ embeds: [embed], components: [row] });
  },
};
