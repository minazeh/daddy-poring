# Deploying this bot to Railway

This bot runs on Railway as a **worker** (a long-running Node process — no web port).
Railway auto-detects Node from `package.json`, runs `npm install`, then `npm start`
(`node index.js`), and restarts the process if it crashes.

Everything below the "What you must do" line needs **your** Railway / GitHub accounts —
it can't be done for you.

---

## Already prepared (local)
- `package.json` → `start` script + `engines: node >=18` (Railway reads both).
- `.gitignore` excludes `node_modules/` and `.env` (your token never reaches git).
- `.railwayignore` excludes the same for `railway up` (CLI) deploys.
- Git repo initialized with an initial commit.
- Code verified Linux-safe (no Windows/absolute paths; portable file loaders).

---

## What you must do

### Option A — GitHub (recommended)
1. Create an empty repo on GitHub (private is fine).
2. From this folder:
   ```bash
   git remote add origin https://github.com/<you>/<repo>.git
   git branch -M main
   git push -u origin main
   ```
3. On https://railway.app → **New Project** → **Deploy from GitHub repo** → select the repo.
   Railway builds and starts it automatically.

### Option B — Railway CLI (no GitHub)
```bash
npm i -g @railway/cli
railway login
railway init
railway up
```

---

## Environment variables (set in Railway → project → Variables)
The `.env` file is NOT pushed, so set these in the Railway dashboard:

| Variable | Notes |
|---|---|
| `DISCORD_TOKEN` | Bot token (Developer Portal → Bot). |
| `CLIENT_ID` | Application ID. |
| `GUILD_ID` | Your server ID. Required — slash commands auto-register to this guild on startup. |
| `APPLICATION_CHANNEL_ID` | Guild-application submissions channel. |
| `STAFF_ROLE_ID` | Optional. |

(The reviewer roles, class/welcome channel IDs are constants in `guildapp/constants.js`
and `events/guildMemberAdd.js`, so they don't need env vars.)

`dotenv` reads `process.env`, so Railway-injected variables work with no code changes —
the missing `.env` file is harmless in production.

---

## Don't forget
- **Server Members Intent** must be enabled in the Developer Portal (Bot → Privileged
  Gateway Intents) — required for the welcome-on-join event. Same as locally; unrelated to host.
- **No exposed port** — Railway may warn about this. Ignore it; the bot doesn't serve HTTP.
- **No separate deploy step** — slash commands auto-register on startup (needs `GUILD_ID` set).
- **Cost** — Railway has no free tier; the Hobby plan (~$5/mo usage-based) covers a small bot easily.
