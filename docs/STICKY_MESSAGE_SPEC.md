# /stickymessage — Scope

**Status:** scoped, awaiting build
**Date:** 2026-08-24

---

## 1. What this is

A general-purpose sticky message. An officer runs `/stickymessage set` in any text
channel, types the content into a modal, and the bot keeps that message pinned to
the **bottom** of the channel — reposting it whenever conversation pushes it up.

Discord cannot pin to the bottom of a channel, so the bot fakes it the same way
the two existing engines do: on each new human message, post a fresh copy and
delete the previous one, debounced, and skipped entirely when the sticky is
already the newest message. Deleting its own message needs no permissions.

---

## 2. Reuse

**`ticket/sticky.js` is the model — it is already the N-channel variant.** It
keeps a `Map` keyed by channel id with **per-channel** debounce state (so one busy
channel cannot starve another), treats the Map as a cache rather than the source
of truth, and rebuilds it from the database in `resume()` on boot. That is exactly
the shape this needs. `activitycampaign/sticky.js` is the single-channel version
and is the wrong model here.

Follow `ticket/sticky.js` for structure, `ticket/db.js` for persistence, and hook
`onMessage` into `events/messageCreate.js` alongside the two existing calls —
guarded the same way, in its own try/catch, so a sticky failure can never take
down kudos or the quiz engine.

The `messageCreate` hook must stay a single `Map.has()` for the 99% of messages
that are not in a sticky channel.

---

## 3. Commands

`/stickymessage` — **Godfathers + officers** (`GODFATHERS_ROLE_ID` +
`TICKET_OFFICER_ROLE_IDS`, the same combined gate the carry Mark-Paid buttons use).

| Subcommand | Effect |
|---|---|
| `set` | Opens the modal; sticks the result to **the channel the command was run in** |
| `edit` | Reopens the modal **pre-filled** with the current content, for the sticky in this channel |
| `remove` | Deletes the sticky and stops watching this channel |
| `list` | Every active sticky across the server, with its channel and who set it |

`set` in a channel that already has one **replaces** it, and says so in the
ephemeral confirmation.

---

## 4. The modal

Three inputs, at most:

| Field | Style | Required | Notes |
|---|---|---|---|
| Content | Paragraph | Yes | Up to 4,000 chars (Discord's modal cap) |
| Title | Short | No | Presence of a title is what selects embed vs plain text |
| Colour | Short | No | Hex, e.g. `#5865F2`. Ignored unless a title is given |

**Format is chosen per sticky, by what you fill in** (Conrad, 2026-08-24):

- **Title blank → plain text.** Markdown renders natively and it stays visually
  quiet at the bottom of a conversation.
- **Title filled → embed**, using the colour if supplied, else the house blurple
  already used by `/help` and `/guildexpedition`.

### 4.1 The length trap — this is the one that bites

A modal paragraph input accepts **4,000** characters. A plain Discord message
caps at **2,000**. An embed description caps at **4,096**.

So content between 2,001 and 4,000 characters **cannot be posted as plain text**.
Rule: if no title was given and the content exceeds 2,000 characters, **post it as
a titleless embed** rather than refusing or truncating, and say so in the
ephemeral confirmation ("over 2,000 characters, so this was posted as an embed").
Never truncate content the officer typed.

Invalid hex is not an error — fall back to the default colour and mention it in
the confirmation.

---

## 5. Sticky-on-sticky — the real risk

Two sticky engines in one channel each race to be the newest message and
**ping-pong forever**, burning rate limit and spamming the channel.

`set` must **refuse** in a channel already owned by another engine:

- an open ticket channel (check the tickets collection / `ticket/sticky.js`'s
  watch set), and
- the activity-campaign channel (`activitycampaign/constants.js`).

The refusal names which feature owns the channel. This is a deliberate
limitation, not an oversight — document it in the confirmation copy.

---

## 6. Behaviour

- **Debounce:** 10 seconds per channel. (Ticket uses 5s for a low-traffic private
  channel, campaign uses 30s. 10s suits a general channel.)
- **Skip when already newest** — no repost if nothing has been said since.
- **Bot messages never trigger a repost**, including the bot's own sticky.
- **Sticky deleted by hand** → reposted on the next human message; the new message
  id is persisted.
- **Channel deleted** → the watch is dropped and the record cleaned up rather than
  retrying forever.
- **Database unreachable** → `onMessage` skips reposting entirely; the bot stays
  up and nothing crashes. Existing stickies simply stop following.

---

## 7. Storage

New `sticky_messages` collection, own `MongoClient`, same isolation pattern as
every other subsystem:

```
{ _id: '<channelId>', guildId, content, title, color,
  messageId, setBy, setByName, createdAt, updatedAt }
```

One document per channel — `_id` being the channel id enforces one sticky per
channel for free.

`resume()` on boot rebuilds the watch Map from this collection and re-attaches
each sticky by its persisted `messageId`.

---

## 8. Files

```
sticky/constants.js   gate, debounce, modal ids, copy, default colour
sticky/db.js          sticky_messages, own MongoClient
sticky/engine.js      the watch Map, debounce, repost — modelled on ticket/sticky.js
sticky/handlers.js    modal open/submit, embed-vs-plain build, route()
sticky/resume.js      rebuild the Map on boot
commands/stickymessage.js
```

Edited: `events/messageCreate.js` (one guarded `onMessage` call),
`events/interactionCreate.js` (one `route()` call, `sticky:` namespace only),
`events/ready.js` (init + resume).

Estimated 700–900 lines.

---

## 9. What to prove

- Repost fires after debounce, not before; per-channel state, so a busy channel
  does not stall a quiet one.
- No repost when the sticky is already newest.
- Bot messages do not trigger reposts (no self-trigger loop).
- Over-2,000-character content with no title becomes a titleless embed, and is
  **never truncated**.
- Invalid hex falls back rather than erroring.
- `set` is refused in a ticket channel and in the campaign channel, naming the
  owner.
- Restart rebuilds the watch Map and re-attaches by `messageId`.
- `route()` claims only `sticky:` ids, and no existing router claims a `sticky:`
  id — both directions, as the carry build did.
- Command registration count goes up by exactly one, every other command intact.

---

## 10. Out of scope

- Scheduled or expiring stickies.
- More than one sticky per channel.
- Stickies in threads or DMs.
- Buttons or components on the sticky content.
