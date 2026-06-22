const { Events } = require('discord.js');
const { registerCommands } = require('../lib/registerCommands');

module.exports = {
  name: Events.ClientReady,
  // once: true fires the handler only on the first emit (correct for the ready event).
  once: true,
  async execute(client) {
    console.log(`[ready] Logged in as ${client.user.tag}`);

    // Auto-register slash commands on every startup.
    // A failure here is non-fatal — bot stays online with previously registered commands.
    try {
      await registerCommands(client.commands);
    } catch (err) {
      console.error('[ready] Slash command auto-registration failed (bot still online):', err);
    }
  },
};
