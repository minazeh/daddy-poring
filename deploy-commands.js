/**
 * deploy-commands.js — manual fallback for `npm run deploy`
 *
 * Loads command files from commands/ and calls the shared registerCommands()
 * function. Identical logic to the auto-registration that runs on bot startup
 * via events/ready.js, just invoked standalone so Conrad can push an update
 * without restarting the bot if needed.
 */
require('dotenv').config();

const fs   = require('node:fs');
const path = require('node:path');
const { Collection } = require('discord.js');
const { registerCommands } = require('./lib/registerCommands');

// ---------------------------------------------------------------------------
// Build a Collection matching the shape client.commands uses at runtime.
// ---------------------------------------------------------------------------
const commands     = new Collection();
const commandsPath = path.join(__dirname, 'commands');
const commandFiles = fs.readdirSync(commandsPath).filter(f => f.endsWith('.js'));

for (const file of commandFiles) {
  const command = require(path.join(commandsPath, file));
  if ('data' in command && 'execute' in command) {
    commands.set(command.data.name, command);
    console.log(`[deploy] Queued: ${command.data.name}`);
  } else {
    console.warn(`[deploy] Skipped ${file} — missing "data" or "execute".`);
  }
}

// ---------------------------------------------------------------------------
// Validate env vars before hitting the API — hard-fail here unlike the
// startup path, because a manual deploy with missing vars is a config error.
// ---------------------------------------------------------------------------
const { DISCORD_TOKEN, CLIENT_ID, GUILD_ID } = process.env;

if (!DISCORD_TOKEN || !CLIENT_ID || !GUILD_ID) {
  console.error('[deploy] Missing env vars. Ensure DISCORD_TOKEN, CLIENT_ID, and GUILD_ID are set in .env.');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Register.
// ---------------------------------------------------------------------------
registerCommands(commands).catch(err => {
  console.error('[deploy] Registration failed:', err);
  process.exit(1);
});
