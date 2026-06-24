const { Events } = require('discord.js');
const { registerCommands } = require('../lib/registerCommands');
const kudosDb = require('../kudos/db');

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

    // Kudos: connect to MongoDB + ensure indexes (idempotent). If MONGODB_URI is
    // missing or Atlas is unreachable, the bot keeps running — kudos surfaces show
    // a "not configured" message instead. initSchema() handles its own errors and
    // returns true only on a successful connect; it never throws to the boot path.
    try {
      const ok = await kudosDb.initSchema();
      if (ok) {
        console.log('[ready] Kudos store ready (MongoDB).');
      } else if (process.env.MONGODB_URI) {
        console.warn('[ready] Kudos disabled — could not connect to MongoDB (check Atlas Network Access / URI).');
      } else {
        console.warn('[ready] Kudos disabled — MONGODB_URI not set.');
      }
    } catch (err) {
      console.warn('[ready] Kudos init failed (kudos degraded, bot still online):', err?.message || err);
    }
  },
};
