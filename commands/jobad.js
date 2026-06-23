const {
  SlashCommandBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
} = require('discord.js');

const { IDS, FIELDS } = require('../officerapp/constants');
// /jobad is leadership-only — reuses the guild-app reviewer roles.
const { REVIEWER_ROLE_IDS } = require('../guildapp/constants');

// Returns true only if the member holds at least one reviewer (leadership) role.
function isLeadership(interaction) {
  const member = interaction.member;
  if (!member) return false;
  return REVIEWER_ROLE_IDS.some(roleId => member.roles?.cache?.has?.(roleId));
}

module.exports = {
  // Registered with Discord's API via the auto-loader on restart.
  data: new SlashCommandBuilder()
    .setName('jobad')
    .setDescription('Post a job ad members can apply to (leadership only).'),

  // Invoke gate -> show the Job Ad modal directly (no defer/reply first).
  async execute(interaction) {
    if (!isLeadership(interaction)) {
      await interaction.reply({
        content: "Sorry — you don't have permission to use this command.",
        ephemeral: true,
      });
      return;
    }

    const modal = new ModalBuilder()
      .setCustomId(IDS.JOBAD_MODAL)
      .setTitle('Post a Job Ad');

    const title = new TextInputBuilder()
      .setCustomId(FIELDS.AD_TITLE)
      .setLabel('Title')
      .setStyle(TextInputStyle.Short)
      .setPlaceholder('e.g. Raid Officer')
      .setRequired(true);

    const description = new TextInputBuilder()
      .setCustomId(FIELDS.AD_DESCRIPTION)
      .setLabel('Description')
      .setStyle(TextInputStyle.Paragraph)
      .setPlaceholder('What the role involves and what you are looking for.')
      .setRequired(true);

    // Each text input sits in its own action row.
    modal.addComponents(
      new ActionRowBuilder().addComponents(title),
      new ActionRowBuilder().addComponents(description),
    );

    // A slash command may show a modal as its first response.
    await interaction.showModal(modal);
  },
};
