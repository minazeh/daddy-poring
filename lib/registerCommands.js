/**
 * registerCommands.js
 *
 * Shared registration logic used by:
 *   - events/ready.js  → auto-registers on every bot startup
 *   - deploy-commands.js → manual `npm run deploy` fallback
 *
 * @param {import('discord.js').Collection} commands
 *   A Collection (or Map) of command modules, each with a `.data.toJSON()` method.
 *   Pass `client.commands` from index.js, or build an equivalent collection in
 *   deploy-commands.js for the standalone path.
 */

require('dotenv').config();

const { REST, Routes } = require('discord.js');

/**
 * Registers all commands in `commands` to the configured guild via Discord REST.
 *
 * @param {import('@discordjs/collection').Collection} commands
 * @returns {Promise<void>}
 */
async function registerCommands(commands) {
  const { DISCORD_TOKEN, CLIENT_ID, GUILD_ID } = process.env;

  if (!GUILD_ID) {
    console.warn('[registerCommands] GUILD_ID is not set — skipping auto-registration.');
    return;
  }
  if (!DISCORD_TOKEN || !CLIENT_ID) {
    console.warn('[registerCommands] DISCORD_TOKEN or CLIENT_ID is not set — skipping auto-registration.');
    return;
  }

  const payload = [];
  for (const command of commands.values()) {
    if (command.data && typeof command.data.toJSON === 'function') {
      payload.push(command.data.toJSON());
    }
  }

  const rest = new REST().setToken(DISCORD_TOKEN);

  console.log(`[registerCommands] Registering ${payload.length} command(s) to guild ${GUILD_ID}…`);

  const data = await rest.put(
    Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID),
    { body: payload },
  );

  console.log(`[registerCommands] Registered ${data.length} slash command(s) to guild ${GUILD_ID}.`);
}

module.exports = { registerCommands };
