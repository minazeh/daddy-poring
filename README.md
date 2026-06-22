# discord-bot

Discord bot scaffold using discord.js v14 with slash command support. Feature commands TBD — Conrad to spec after reviewing this scaffold.

## Prerequisites

- Node.js 18+ (tested on v22)
- A Discord bot application — create one at https://discord.com/developers/applications

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Fill in `.env`

Copy `.env.example` → `.env` and fill in three values:

| Variable | Where to get it |
|---|---|
| `DISCORD_TOKEN` | Developer Portal → your app → **Bot** → **Reset Token** |
| `CLIENT_ID` | Developer Portal → your app → **General Information** → **Application ID** |
| `GUILD_ID` | In Discord: enable **Developer Mode** (User Settings → Advanced), then right-click your test server → **Copy Server ID** |

### 3. Invite the bot to your server

In the Developer Portal → your app → **OAuth2 → URL Generator**:
- Scopes: `bot`, `applications.commands`
- Bot permissions: whatever your features need (at minimum none for slash-only)

Open the generated URL and add the bot to your test server.

### 4. Register slash commands

```bash
npm run deploy
```

This registers commands to your guild (instant updates). Run this every time you add or change a command.

> To switch to global registration (takes up to 1 hour): see the comment in `deploy-commands.js`.

### 5. Start the bot

```bash
npm start
```

You should see `[ready] Logged in as YourBot#0000`. Type `/ping` in your server.

## Adding a new slash command

1. Create `commands/your-command.js` — copy the shape from `commands/ping.js`.
2. Export `data` (a `SlashCommandBuilder`) and `execute(interaction)`.
3. Run `npm run deploy` to register it with Discord.
4. Restart the bot (`npm start`).

That's it — the command loader picks it up automatically.

## Project structure

```
discord-bot/
├── commands/
│   └── ping.js           # Example command — /ping → latency reply
├── events/
│   ├── ready.js          # Fires once on login
│   └── interactionCreate.js  # Dispatches slash commands
├── deploy-commands.js    # Registers commands with Discord's API (npm run deploy)
├── index.js              # Bot entrypoint — loads commands + events, logs in
├── .env                  # Your secrets (gitignored)
├── .env.example          # Documents required vars
└── package.json
```
