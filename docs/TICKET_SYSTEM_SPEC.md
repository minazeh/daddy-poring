# Guild Support Ticket System — Scope

| | |
|---|---|
| **Status** | SCOPE ONLY — nothing built, nothing committed |
| **Author** | Nanna |
| **Date** | 2026-08-15 |
| **Repo** | `projects/discord-bot` (+ no web-app changes) |
| **Pattern source** | `guildapp/` (spawnable embed → modal → review channel → action buttons), `activitycampaign/` (sticky engine + Mongo config), `officerapp/` (per-feature Mongo client) |

---

## 1. What this is

A support-ticket feature that mirrors the guild application flow you already have:

1. A Godfather runs **`/guildsupport`** → the bot posts a public panel embed with an **Open Ticket** button.
2. Any member clicks it → a modal asks **Subject** and **Message**.
3. On submit the bot posts a **ticket embed** to the open-tickets channel, carrying the member's profile (display name, tag, ID, every role they hold, join date, account age) plus their subject and message, with officer action buttons.
4. An officer **accepts** → the bot creates a **private channel** visible only to the ticket creator, the seven officer roles, and itself.
5. That channel gets a **sticky message with a Mark as Resolved button** that stays at the bottom of the conversation.
6. On resolve → the bot generates a **transcript**, posts it to the transcript channel, and closes the ticket channel.

**Everything survives a bot restart.** Section 7 is dedicated to that, because it is the requirement most likely to be quietly broken and the hardest to retrofit.

---

## 2. IDs you supplied

### Officer roles — can see and act on every ticket

| Role ID | Identified as | Source |
|---|---|---|
| `1518076150692188200` | **Godfathers** | `activitycampaign/constants.js:13`, `gvg/constants.js:13` |
| `1518076612787048548` | **Officer Daddy** | `officerapp/constants.js:46`, `partyfinder/constants.js:90` |
| `1518666580903329822` | **Officer Mummy** | `officerapp/constants.js:47`, `partyfinder/constants.js:91` |
| `1518666539182592080` | *(unnamed — is a guild-app reviewer)* | `guildapp/constants.js:40` |
| `1518861067835412502` | *(unknown — appears nowhere in the repo)* | — |
| `1518517404886372483` | *(unknown — appears nowhere in the repo)* | — |
| `1537890748945661972` | *(unknown — recently created snowflake)* | — |

Three of these appear nowhere in the codebase. That's fine — it just means I can't sanity-check them by name. **Worth you eyeballing the list once before build**, because a wrong ID here fails silently: the role simply never sees ticket channels, and nothing errors.

**All seven roles may Accept a ticket and Resolve/close it** (Conrad, 2026-08-15). One role list, one gate, used for both actions — `TICKET_OFFICER_ROLE_IDS`.

### Channels

| Purpose | ID |
|---|---|
| Open-ticket embeds land here | `1537891584593371218` |
| Transcripts land here | `1537891493598208000` |
| **Parent category for private ticket channels** | `1537895407009665164` |

### Command gating

`/guildsupport` is **Godfathers only** — `1518076150692188200`. This is already an established pattern; `commands/activitycampaign.js:44` has the exact `isGodfather()` helper to copy.

---

## 3. Substrate — DECIDED: private text channel

**Conrad's call, 2026-08-15: private text channel, with privacy enforced on the channel itself.** The analysis that led there is kept below because the 50-per-category cap it surfaces is now a live operational constraint, not a hypothetical.

### Text channel vs forum post

You said "text channel **OR** forum post". These are not equivalent, and one of them cannot do what you asked.

| | Private text channel | Private thread | Forum post |
|---|---|---|---|
| Per-ticket privacy | ✅ Permission overwrites, exact | ✅ Invite-only membership | ❌ **Cannot do it** |
| Sticky message | ✅ Natural | ✅ Works | ⚠️ Awkward |
| Transcript | ✅ Clean fetch | ✅ Clean fetch | ✅ Clean fetch |
| Volume ceiling | ⚠️ **500 channels/guild, 50/category** | ✅ No practical cap | ✅ No cap |
| Auto-archive risk | ✅ None | ⚠️ Archives after inactivity | ⚠️ Same |

**Forum posts can't give you what you asked for.** Threads in a forum inherit the parent forum's view permission — a member who can't see the forum can't see their own post inside it. There's no per-thread overwrite. So "only visible to the ticket creator and specific officer roles" is unachievable with a forum unless every member can see every ticket.

**My recommendation: private text channel.** It matches your mental model, permissions are exact and auditable, the sticky behaves exactly like the activity-campaign one, and nothing auto-archives out from under an open ticket.

**The catch you should know about:** Discord caps a guild at **500 channels** and a category at **50**. So the channel lifecycle in §6.5 isn't housekeeping — it's what stops the feature hitting a hard wall. If you expect sustained high volume, private threads are the safer substrate and I'd switch the recommendation.

**→ DECIDED: private text channel.**

### 3.1 The category cap is now the binding constraint

All ticket channels live in one category, `1537895407009665164`. **Discord caps a category at 50 channels.** That turns the close-and-delete lifecycle from housekeeping into the thing that stops the feature wedging: at 50 live channels, Accept starts failing and no new ticket can be opened.

Consequence, decided rather than left open: **resolved channels are deleted, not archived in place.** Archiving inside the same category would consume the same 50 slots and simply delay the wall. The transcript in `1537891493598208000` is the durable record; the channel is not.

Accept also pre-checks the category's child count and refuses with a specific message when it is full, rather than failing on the Discord API error.

---

## 4. Decisions

All resolved 2026-08-15 — Conrad answered 1–2 directly and authorised the stated defaults for the rest.

| # | Question | Resolution |
|---|---|---|
| 1 | Category for ticket channels | **`1537895407009665164`** |
| 2 | Who may Accept / Resolve | **All seven roles, both actions.** One list, one gate |
| 3 | Decline path | **Yes** — closes with a reason, DMs the member, no channel created |
| 4 | Resolve: delete or archive | **Delete after a 24h grace**, locked and renamed `closed-…` in between (§3.1) |
| 5 | Open tickets per member | **One.** A second attempt gets an ephemeral pointer to the existing channel |
| 6 | Sticky copy | Drafted in `constants.js` as `STICKY_TEXT` — one edit point, reworded freely |
| 7 | DM the member | **Yes**, best-effort on accept / resolve / decline, same as guildapp |
| 8 | Channel naming | **`ticket-0042-username`**, sanitised, number-first so it is always unique |

---

## 5. Files

```
discord-bot/
├── commands/
│   └── guildsupport.js          NEW  /guildsupport — Godfathers only, posts the panel
├── ticket/
│   ├── constants.js             NEW  IDs, role lists, channel IDs, copy, colours
│   ├── db.js                    NEW  Mongo — own MongoClient, per the house pattern
│   ├── handlers.js              NEW  route() + every interaction handler
│   ├── channel.js               NEW  create/lock/delete private channel + overwrites
│   ├── sticky.js                NEW  per-ticket sticky engine (multi-channel)
│   └── transcript.js            NEW  fetch history → render → post
├── events/
│   ├── interactionCreate.js     EDIT one router line (additive)
│   ├── messageCreate.js         EDIT one sticky hook (additive)
│   └── ready.js                 EDIT one resume call (additive)
└── deploy-commands.js           no change (dynamic loader picks the command up)
```

Three existing files get **one additive line each**. No behaviour change to any current feature. This is the same shape every feature in this bot has taken.

---

## 6. Flow detail

### 6.1 `/guildsupport` — panel

Godfathers only; non-Godfathers get an ephemeral refusal. Posts a public embed + one **Open Ticket** button (`ticket:open`, **static customId**, so the panel keeps working forever across restarts and redeploys — same trick as `activitycampaign:yes`).

The panel is fire-and-forget: post it once in your support channel and leave it.

### 6.2 Open Ticket → modal

Two components, well inside Discord's 5-component cap:

| Field | Style | Required | Cap |
|---|---|---|---|
| Subject | Short | Yes | 100 chars |
| Message | Paragraph | Yes | 1,000 chars |

Guard first: if the member already has an open ticket, refuse ephemerally with a link to it rather than opening the modal.

**No pending-state map needed.** Unlike guildapp — which holds answers between the modal and a second step in a TTL Map that dies on restart — everything here arrives in one submit and is written to Mongo immediately. There is no in-flight window to lose.

### 6.3 Ticket embed → open-tickets channel `1537891584593371218`

Written to Mongo **first**, posted **second**, message ID recorded third. So a crash mid-flow leaves a recoverable ticket, never a phantom.

| Field | Content |
|---|---|
| Ticket | `#0042` (zero-padded, from a Mongo counter) |
| Member | mention + `user.tag` + raw ID |
| Roles | **every role they hold**, highest first, `@everyone` excluded |
| Joined server | `<t:…:F>` + `<t:…:R>` (Discord renders these in each viewer's own timezone) |
| Account created | same treatment |
| Subject | from the modal |
| Message | from the modal |
| Status | `🟡 Open` |

Buttons: **Accept** (green) · **Decline** (red) — `ticket:accept:<ticketId>` / `ticket:decline:<ticketId>`. The ticket ID rides in the customId, so a restarted process reconstructs full context from the click alone with no memory of having posted it.

> ⚠️ **"All roles" will overflow.** An embed field caps at **1,024 characters** and a full role list on a long-standing member can exceed it. The build truncates at the last whole role that fits and appends `+N more` — otherwise Discord rejects the entire message and the ticket silently never appears.

### 6.4 Accept → private channel

1. Re-read the ticket from Mongo, confirm still `open` (guards double-clicks by two officers).
2. Create the channel under category `1537895407009665164`, named per §4.8.
3. Permission overwrites — **passed in the same create call, never applied afterwards**:
   - `@everyone` → **deny** ViewChannel
   - ticket creator → allow ViewChannel, SendMessages, ReadMessageHistory, AttachFiles, EmbedLinks
   - each of the 7 officer roles → same allow set
   - bot → the above plus ManageChannels, ManageMessages

   > **Privacy is enforced on the channel, explicitly, and it is atomic.** Two things this guards against. First, a channel created and *then* locked down is briefly visible to the whole server — passing `permissionOverwrites` to `guild.channels.create()` means the channel never exists in a readable state. Second, **the overwrites are explicit rather than inherited**: a new channel normally syncs its parent category's permissions, so if that category is ever opened up to a role, every ticket inside it would open up too. Writing an explicit `@everyone` deny plus an explicit allow-list makes the channel's privacy independent of whatever the category is set to.
4. Post a header embed restating subject + message so context lives in the channel.
5. Post the **sticky** (§6.6).
6. Update the original embed: status `🟢 Accepted`, add "Accepted by", disable both buttons, add a link button to the new channel.
7. Best-effort DM the creator.

Steps 2–5 are wrapped: if channel creation fails (permissions, 500-channel cap), the ticket returns to `open`, both buttons stay live, and the officer gets a specific ephemeral error. **No silent half-states.**

### 6.5 Resolve → transcript → close

Sticky button `ticket:resolve:<ticketId>`. **Who may press it — my recommendation: officers only.** If the creator can resolve their own ticket, an accidental click ends the conversation and only an officer can reopen it. Say the word if you want it open to both.

On press:
1. Mark `resolved` in Mongo with resolver + timestamp.
2. Fetch the full channel history, oldest → newest, paginating past Discord's 100-message limit.
3. Render a transcript (§6.7) and post to `1537891493598208000` with a summary embed: ticket #, creator, subject, opened/resolved timestamps, resolver, message count, attachment.
4. Replace the sticky with a static "Resolved by X" notice, no buttons.
5. Lock the channel (revoke SendMessages for the creator, keep it readable), rename to `closed-…`.
6. Delete after the §4.4 grace period.
7. Best-effort DM the creator.

**The transcript is posted before the channel is touched.** If transcript posting fails, the channel is left fully intact and the officer is told — a lost conversation is unrecoverable, a stuck channel is a nuisance.

### 6.6 The sticky

Same mechanism as `activitycampaign/sticky.js`: Discord can't pin to the bottom, so on each new human message the bot deletes its previous sticky and reposts, debounced so a chat burst collapses into one trailing repost.

**One material difference: this one is multi-channel.** The campaign sticky tracks a single channel in one cache object. This tracks N open tickets simultaneously, so the cache is a `Map<channelId, {ticketId, stickyMessageId}>` with per-channel debounce state, and the `messageCreate` hook is a single `Map.has()` — free for the 99% of messages that aren't in a ticket channel.

Deleting its own previous message needs no Manage Messages permission — bots can always delete their own.

### 6.7 Transcript format

**Recommendation: a `.txt` file attachment plus a summary embed.**

```
[2026-08-15 14:03:11 UTC] Username (123456789012345678): message text
    ↳ attachment: https://cdn.discordapp.com/...
```

Plain text over HTML because it's greppable, has no rendering dependency, and stays readable in Discord's own preview. Attachments are recorded as URLs — **Discord CDN links now expire**, so the transcript preserves that a file was sent and its name, not the file itself. If you need durable attachment capture, that's a separate piece of work and I'd scope it on its own.

---

## 7. Restart durability

Your requirement, treated as a design constraint rather than a feature. Every piece of state is either in Mongo or reconstructible from a customId.

| State | Survives how |
|---|---|
| The `/guildsupport` panel | **Static customId** (`ticket:open`) — no state at all. Works forever, including after a redeploy. |
| Open/accepted tickets | Mongo `tickets` collection. |
| Which channel belongs to which ticket | Stored on the ticket doc, **and** the ticket ID rides in every button customId. |
| Accept/Decline buttons on old embeds | `ticket:accept:<ticketId>` — a restarted process resolves the whole ticket from Mongo on click. |
| Resolve button on old stickies | `ticket:resolve:<ticketId>` — same. |
| Sticky positions | `stickyMessageId` on the ticket doc; the in-memory Map is a **cache, not the source of truth**. |
| Which channels the sticky watches | Rebuilt on `ready` by querying all `accepted` tickets. |
| Ticket counter | Mongo `findOneAndUpdate` with `$inc` — **atomic**, so two simultaneous submissions can't collide on a number. |
| In-flight modal answers | **None exist by design** (§6.2). |

**On `ready`** the feature runs a resume pass: load every accepted ticket, drop any whose channel no longer exists (marking them `orphaned` rather than deleting the record), rebuild the sticky Map, and repost each sticky so it's at the bottom after downtime — exactly what `activitycampaign/sticky.js:resume()` does, extended to N channels.

**Degraded mode.** Following the house pattern: if `MONGODB_URI` is missing or Atlas is unreachable, the bot still boots fully. `/guildsupport` replies "unavailable", Open Ticket is refused ephemerally, and nothing throws into the boot path. A ticket system that takes the whole bot down when the database hiccups is worse than one that's briefly unavailable.

---

## 8. Data model

Mongo `discordbot`, own `MongoClient` per the house pattern (`activitycampaign/db.js:6-10` explains why each feature gets its own).

**`tickets`**
```js
{
  _id:           'ticket:0042',
  number:        42,
  guildId, userId, username, displayName,
  rolesSnapshot: [{ id, name }],   // roles AT SUBMIT TIME — they change later
  joinedAt, accountCreatedAt: Date,
  subject, message: String,
  status:        'open' | 'accepted' | 'resolved' | 'declined' | 'orphaned',
  reviewMessageId, reviewChannelId,
  channelId:        String|null,   // the private channel, once accepted
  stickyMessageId:  String|null,
  acceptedBy, acceptedAt,
  resolvedBy, resolvedAt,
  declinedBy, declinedAt, declineReason,
  transcriptMessageId,
  createdAt, updatedAt: Date,
}
```

**`ticket_counters`** — `{ _id: 'ticketNumber', seq: 42 }`, incremented atomically.

Indexes: `{ userId: 1, status: 1 }` (the open-ticket guard, hit on every submit) and `{ channelId: 1 }` (sticky lookups).

**Why `rolesSnapshot` is stored rather than read live:** the embed must show what they had when they asked. Someone promoted or demoted mid-ticket shouldn't silently rewrite the record an officer is reading.

---

## 9. Bot permissions

**Resolved — the bot holds Administrator** (Conrad, 2026-08-15), which covers Manage Channels, Manage Roles for the overwrites, Manage Messages, Attach Files and everything else this feature touches.

The build still reports permission failures as specific ephemeral messages rather than the generic handler error, because Administrator does not exempt the bot from **role-hierarchy** limits or from Discord's own structural caps (50 channels per category, 500 per guild) — and those produce the same "Accept did nothing" symptom.

---

## 10. Edge cases handled

- Member **leaves the server** mid-ticket → channel stays for officers, transcript still works, DM skipped.
- Ticket channel **manually deleted** by an officer → resume marks it `orphaned` instead of crash-looping.
- Two officers **click Accept simultaneously** → status re-read guards it; the loser gets "already accepted by X".
- Member **spams Open Ticket** → one-open-ticket guard (§4.5).
- Subject/message containing **mentions or markdown** → escaped so a ticket can't `@everyone` the officer channel.
- **Channel-name collisions** → the ticket number makes every name unique.
- Username with characters **illegal in a channel name** → sanitised, number preserved.
- **Transcript exceeds 8 MB** → truncated with a clear marker rather than failing the post.

---

## 11. Explicitly out of scope

Not built unless you ask: ticket claiming/assignment to an individual officer, categories or priorities, SLA timers or auto-close on inactivity, per-officer stats, reopening a resolved ticket, web-app surfacing, and durable attachment archiving (§6.7).

---

## 12. Build plan

| Phase | Content | Verifiable by |
|---|---|---|
| 1 | `constants.js`, `db.js`, atomic counter, indexes, degraded-mode path | Bot boots with and without `MONGODB_URI` |
| 2 | `/guildsupport` panel + modal + ticket embed to `1537891584593371218` | A ticket embed appears with correct profile data |
| 3 | Accept/Decline + private channel creation + overwrites | Creator sees the channel; a non-officer non-creator does not |
| 4 | Multi-channel sticky engine | Sticky stays at the bottom under chat load in two tickets at once |
| 5 | Resolve → transcript → post → lock → delete | Transcript lands in `1537891493598208000`, channel closes |
| 6 | `ready` resume + orphan reconciliation | **Restart the bot mid-ticket; every button still works** |

Phase 6 is where the restart requirement gets proven, but it's designed in from phase 1 — it is not a bolt-on.

**Rough size:** ~900–1,100 lines across 6 new files plus 3 one-line edits. This is a Kai build at **Opus** tier — multi-file, stateful, permission-sensitive, with a genuine concurrency concern in the counter and the accept race.

---

## 13. Open items summary

**Nothing blocking.** All decisions in §3 and §4 are resolved; build authorised by Conrad 2026-08-15.

**Still worth your eye, non-blocking:** the three role IDs in §2 that appear nowhere in the codebase (`1518861067835412502`, `1518517404886372483`, `1537890748945661972`). A wrong ID there fails silently — that role simply never sees ticket channels and nothing errors.
