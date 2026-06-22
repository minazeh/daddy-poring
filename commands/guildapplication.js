const {
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require('discord.js');

const { IDS } = require('../guildapp/constants');

module.exports = {
  // Registered with Discord's API via deploy-commands.js.
  data: new SlashCommandBuilder()
    .setName('guildapplication')
    .setDescription('Post the guild application prompt with a Start button.'),

  // Posts the public "Guild Application" embed + Start button to the channel so
  // any member who should apply can click it.
  async execute(interaction) {
    const embed = new EmbedBuilder()
      .setTitle('Guild Application')
      .setDescription(
        'Click **Start Application** below to apply for membership.\n\n' +
        "Here's what you'll be asked to fill in:\n\n" +
        '**In-game Name** — your actual in-game character name (IGN)\n' +
        '**Playstyle** — how you like to play, e.g. competitive, casual, purely PvP, purely PvE, or something more elaborate\n' +
        '**Previous Guild (CBT)** — the guild you were in during Closed Beta, if any\n' +
        '**Inviter** — who invited you to apply, if anyone\n\n' +
        'Your application is subject for approval. Please be patient.'
      )
      .setColor(0x2b2d31); // dark embed accent matching the reference

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(IDS.START_BUTTON)
        .setLabel('Start Application')
        .setStyle(ButtonStyle.Danger), // red accent button
    );

    // Posted publicly in the channel; the Start button is clickable by anyone.
    await interaction.reply({ embeds: [embed], components: [row] });
  },
};
