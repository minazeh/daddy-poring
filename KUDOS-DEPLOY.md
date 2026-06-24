# Kudos Board — Deploy Steps (MongoDB Atlas)

The Kudos Board needs a **MongoDB Atlas** database (for persistence) and the
**Message Content Intent** (so the bot can read `kudos @member` chat messages).
Until both are done, the bot still runs normally — kudos just replies
"not configured yet."

One Atlas SRV connection string works from both your laptop and Railway, so the
same `MONGODB_URI` is used in both places — they share one database.

---

## 1. Set `MONGODB_URI` in BOTH places

You already have your Atlas cluster + connection string. Put the **same** value in:

1. **Local** — `projects/discord-bot/.env`:
   ```
   MONGODB_URI=mongodb+srv://USER:PASS@cluster0.xxxxx.mongodb.net/
   ```
   (`.env` is gitignored — it never reaches GitHub.)

2. **Railway** — bot service → **Variables** → add `MONGODB_URI` with the same value.

That's what makes your laptop and the Railway bot read/write the same data.

---

## 2. Atlas Network Access → allow `0.0.0.0/0` (the #1 gotcha)

Atlas blocks all connections by default. **Railway's outbound IPs are dynamic**, so
an IP allowlist won't work — you must allow from anywhere:

Atlas → your project → **Network Access** → **Add IP Address** →
**ALLOW ACCESS FROM ANYWHERE** (`0.0.0.0/0`) → Confirm.

(Security still holds: connections require the username/password in the URI. Without
this, the bot logs a connect failure and kudos stays disabled — the rest of the bot
keeps running.)

---

## 3. Enable the Message Content Intent (Discord Developer Portal)

Discord Developer Portal → your application → **Bot** → **Privileged Gateway
Intents** → toggle **Message Content Intent** ON → save.

Without this, the bot connects but receives **empty** message content, so
`kudos @member` will silently do nothing. (Server Members Intent should already be
on from the welcome-on-join feature — leave it on.)

---

## 4. Redeploy & verify

1. Redeploy the bot (push to GitHub, or `railway up`).
2. On boot the bot connects to Atlas and ensures the indexes (idempotent). Watch the
   logs for:

   ```
   Kudos store ready (MongoDB).
   ```

   If you instead see `Kudos disabled — MONGODB_URI not set`, revisit step 1. If you
   see a connect/timeout error, it's almost always step 2 (Network Access).
3. Test in your server: type `kudos @someone nice work`. The bot should reply
   `🙌 +1 kudo to @someone! (6 left today)`. Then try `/kudosboard` and `/profile`.

---

## How it works (quick reference)

- **Give:** chat `kudos @member [reason]` — up to **7 per giver per day**
  (day resets at **midnight GMT+7**). Tag multiple members in one message.
  No self-kudos, no bot kudos.
- **`/kudosboard`** — top 15 recipients in the server, plus your own rank if you're
  not in the top 15.
- **`/profile [user]`** — total kudos received, rank, and how many they've given today.
- **Storage:** each kudo is one document in the `discordbot.kudos` collection:
  `{ guildId, giverId, recipientId, reason, createdAt }`. Nothing is ever deleted;
  counts are live aggregates.

---

## Env var summary

| Variable | Notes |
|---|---|
| `MONGODB_URI` | Atlas SRV connection string. Set the SAME value locally (`.env`) and in Railway → bot service → Variables. If unset, kudos is disabled but the bot still runs. |
