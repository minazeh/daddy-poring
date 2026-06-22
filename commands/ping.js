const { SlashCommandBuilder } = require('discord.js');

module.exports = {
  // The SlashCommandBuilder data that gets registered with Discord's API.
  data: new SlashCommandBuilder()
    .setName('ping')
    .setDescription('Checks bot latency and responds with Pong!'),

  // Called by the interactionCreate handler when this command is invoked.
  async execute(interaction) {
    const latency = Date.now() - interaction.createdTimestamp;
    await interaction.reply(`Pong! Latency: ${latency}ms | API: ${interaction.client.ws.ping}ms`);
  },
};
