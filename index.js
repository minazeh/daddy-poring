require('dotenv').config();

const fs   = require('node:fs');
const path = require('node:path');
const { Client, Collection, GatewayIntentBits } = require('discord.js');

// ---------------------------------------------------------------------------
// Client
// Slash commands only need the Guilds intent; add more intents here as Conrad
// specifies feature requirements (e.g. GuildMessages for message-content access).
// ---------------------------------------------------------------------------
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers, // Required for guildMemberAdd event
  ],
});

// ---------------------------------------------------------------------------
// Command loader — reads every .js file in commands/ and attaches it to
// client.commands keyed by command name.
// Adding a new command: drop a file in commands/ that exports { data, execute }.
// ---------------------------------------------------------------------------
client.commands = new Collection();

const commandsPath = path.join(__dirname, 'commands');
const commandFiles = fs.readdirSync(commandsPath).filter(f => f.endsWith('.js'));

for (const file of commandFiles) {
  const filePath  = path.join(commandsPath, file);
  const command   = require(filePath);

  if ('data' in command && 'execute' in command) {
    client.commands.set(command.data.name, command);
    console.log(`[commands] Loaded: ${command.data.name}`);
  } else {
    console.warn(`[commands] Skipped ${file} — missing "data" or "execute" export.`);
  }
}

// ---------------------------------------------------------------------------
// Event loader — reads every .js file in events/ and registers it on the client.
// ---------------------------------------------------------------------------
const eventsPath  = path.join(__dirname, 'events');
const eventFiles  = fs.readdirSync(eventsPath).filter(f => f.endsWith('.js'));

for (const file of eventFiles) {
  const filePath = path.join(eventsPath, file);
  const event    = require(filePath);

  if (event.once) {
    client.once(event.name, (...args) => event.execute(...args));
  } else {
    client.on(event.name, (...args) => event.execute(...args));
  }

  console.log(`[events] Registered: ${event.name} (once=${event.once})`);
}

// ---------------------------------------------------------------------------
// Login
// ---------------------------------------------------------------------------
if (!process.env.DISCORD_TOKEN) {
  console.error('[index] DISCORD_TOKEN is not set. Fill in .env and retry.');
  process.exit(1);
}

client.login(process.env.DISCORD_TOKEN);
