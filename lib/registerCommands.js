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

// ---------------------------------------------------------------------------
// RETIRED COMMANDS — loaded, but NOT registered with Discord.
//
// This is the whole mechanism for retiring a command without deleting anything
// (handbook §1.1). Both registration paths — events/ready.js on every startup
// and `npm run deploy` — go through this function, so ONE entry here is the
// least invasive way to take a command off the server: the command FILE and its
// feature module stay on disk untouched and reversible, the loader in index.js
// still attaches it to client.commands (so nothing about the loader changes),
// and Discord simply stops advertising it. Deleting the line puts it back.
//
//   partyfinder — retired 2026-08-24, replaced by the Final Mirage carry-sales
//   system (/carrypanel + /carryrun, docs/CARRY_SYSTEM_SPEC.md). commands/
//   partyfinder.js and the whole partyfinder/ module remain in the repo, and
//   events/interactionCreate.js still routes their component customIds, so any
//   party/carry card posted before the retirement keeps working.
// ---------------------------------------------------------------------------
const RETIRED_COMMANDS = new Set(['partyfinder']);

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
  const retired = [];
  for (const command of commands.values()) {
    if (!command.data || typeof command.data.toJSON !== 'function') continue;
    if (RETIRED_COMMANDS.has(command.data.name)) {
      retired.push(command.data.name);
      continue;
    }
    payload.push(command.data.toJSON());
  }

  if (retired.length) {
    console.log(`[registerCommands] Skipping retired command(s): ${retired.join(', ')} (files kept on disk).`);
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
