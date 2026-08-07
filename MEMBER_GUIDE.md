# Guild Bot — Member Guide

Welcome! This guide covers everything you, as a guild member, can do with our
Discord bot. No admin knowledge needed — just the stuff you'll actually use.

## How the bot works

- **Slash commands:** type `/` in any channel and a menu pops up. Start typing a
  command name (like `/help`) and pick it from the list, then fill in any options
  Discord shows you.
- **Autocomplete:** some commands (all the game-database lookups) suggest matches
  as you type. Start typing a name and **pick one of the suggestions** rather than
  typing the whole thing — it's faster and avoids typos.
- **Private replies:** some responses are **ephemeral**, meaning *only you can see
  them* (they're tagged "Only you can see this"). Others are posted publicly in the
  channel. This guide tells you which is which.
- **Buttons, menus, and modals:** many features use clickable buttons, dropdown
  menus, and pop-up forms ("modals"). Just follow the prompts.
- **Run `/help` any time** to see the commands available to you based on your roles.

---

## Table of Contents

1. [Party Finder](#1-party-finder) — start a party or request a carry (flagship)
2. [Kudos](#2-kudos) — thank people and climb the leaderboard
3. [Quiz](#3-quiz) — answer class questions and rank up
4. [Your Profile](#4-your-profile)
5. [Guild Roster](#5-guild-roster)
6. [Game Database Lookups](#6-game-database-lookups) — monsters, items, cards, and more
7. [Guild Application](#7-guild-application)
8. [Reacting to Leadership Posts](#8-reacting-to-leadership-posts) — expeditions, activity checks, job ads
9. [Utility](#9-utility) — `/help`, `/ping`
10. [Tips & FAQ](#10-tips--faq)

---

## 1. Party Finder

The flagship feature. Use it when you want to **put together a balanced party** for
an event (MVP, raid, etc.) or **ask for a carry**. Everything is posted in the
**#party-finder** channel so others can join.

> You need your guild **class role** (Assassin, Hunter, Knight, Priest, Gunslinger,
> Blacksmith, Wizard, Druid, Paladin, or Monk) and your member role to use Party Finder. If the bot
> says you don't have a recognized class role, ask an officer to assign it.

### Opening the Party Finder card

Run:

```
/partyfinder
```

This posts the **Party Finder card** with two buttons:

- **Start Party** — you're leading and want to fill specific roles.
- **I Need Carry** — you want stronger members to carry you through something.

Everything after you click is **ephemeral** (only you see the prompts) until your
final party/carry card is posted publicly.

### A. Starting a party (tutorial)

1. Click **Start Party**.
2. **Pick your party size** from the dropdown: `5`, `10`, or `Custom`.
   - If you pick **Custom**, you'll type an exact size (1–50) in the next form.
3. **Pick a start time** from the dropdown. Times are shown in **Server time
   (GMT+7)**, in 15-minute steps, starting about 30 minutes from now. If a slot is
   on another day it's labelled with the weekday (e.g. `Wed 12:15 AM`).
4. A **"Start Party — Details"** form pops up. Fill in:
   - **Event name** — e.g. `EDDGA MVP`.
   - **Preferred power rating** — e.g. `50000+`. This is self-reported, so please be
     honest and don't overstate it.
   - *(Custom size only)* **Party size** at the top.
5. Click **Set role counts**. Another form opens asking how many **Tank**, **Heal**,
   and **DPS** slots you need. The three numbers **must add up to your party size**.
   Your own slot is pre-filled to `1` in the role your class fills — count yourself
   in the total.
6. Submit. Your **party card** is posted in **#party-finder**, and you're
   automatically seated in your slot.

**What the party card shows:** the leader, start time (with a live "in X minutes"
countdown), preferred power rating, filled/total size, each role with its filled and
open slots (open ones show `_open_`), and a live **"Recruitment closes"** countdown.

### B. Joining someone else's party

On any open party card you'll see **Join as Tank**, **Join as Heal**, and **Join as
DPS** buttons.

- Click the role you want. You can only join a role **your class is allowed to fill**
  — for example a Knight or Paladin can join **Tank or DPS**, a Priest can join **DPS or Heal**,
  most other classes are **DPS**. If you pick one your class can't do, the bot tells
  you which roles you *can* take.
- **Switching:** already in a slot? Click a different role to switch (if that role has
  space and your class can fill it). Your old slot frees up automatically.
- If a role's slots are already full, the bot says so and you keep your current slot.
- All join/switch confirmations are **ephemeral**.

### C. Leaving a party

- **Leave Party** button — if you joined a party (and you're *not* the leader), click
  this to vacate your slot. It opens back up as `_open_` for someone else.
- The **leader can't** use Leave — as leader you disband with **Cancel** instead.

### D. When a party fills up

Once every slot is filled, the card flips to **✅ PARTY FULL**, the buttons are
removed, and the bot posts a message **@-mentioning everyone in the party** with the
event name and start time so you all get pinged. Be on time!

### E. Cancelling (leaders)

If you started the party, the **Cancel (Leader only)** button disbands it — the card
turns grey and shows **🚫 CANCELLED**. Only the leader can do this.

### F. Requesting a carry

1. Click **I Need Carry** on the Party Finder card.
2. **Pick a start time** (same GMT+7 dropdown as above).
3. Fill in the **Event name** in the pop-up form.
4. Submit. Your **carry request** is posted publicly in **#party-finder** (purple
   card, **🆘 Carry Request**).

**On the carry card:**

- **I'll carry this** — offers to carry you. *Only members with the **Carry** role can
  use this.* When someone offers, their name appears under "Carriers responding".
- **Withdraw** — a carrier who offered can pull their own offer back.
- **Cancel (Requester only)** — you (the requester) close the whole request.

### G. Expiry (parties and carries)

Recruitment automatically **closes 15 minutes before the start time** you picked. If
the party or carry hasn't filled/closed by then, the card turns grey, the countdown is
replaced with "Recruitment closed" / "Request closed", and the buttons are removed. The
card is kept for reference — nothing is deleted. Live countdowns update by themselves,
so no need to refresh.

---

## 2. Kudos

Use kudos to **thank fellow members**. It's not a slash command — you send it as a
normal chat message.

### Giving kudos

Type a message starting with **`kudos`** and **@-mention** one or more people:

```
kudos @Alice thanks for the carry!
```

- You can thank **several people at once**: `kudos @Alice @Bob @Carol`.
- Anything after `kudos` (minus the mentions) is saved as an optional **reason**.
- The bot replies confirming `+1 kudo` to each person and how many you have left today.

**Rules the bot enforces:**

- **7 kudos per day**, resetting at **midnight (GMT+7)**. If you try to give more than
  you have left, the extra recipients are skipped and the bot tells you.
- **No giving yourself kudos**, and **no kudos to bots** — those are ignored.

### `/kudosboard`

```
/kudosboard
```

Shows the **kudos leaderboard** publicly: a **Today** top-10 and an **All-Time** top-10.
If you're not in the all-time top 10, your own rank is shown at the bottom.

---

## 3. Quiz

A trivia game that runs automatically in the **class channels**. Questions appear on
their own during active hours; you don't summon them.

### Answering

When a **📝 Quiz Time!** question appears, it has four buttons — **A, B, C, D** — each
showing an answer choice. Click the one you think is right.

- You get an **ephemeral** reply: **✅ Correct!** or **❌ Wrong!** (a wrong answer
  privately tells you the correct one — it's never shown publicly).
- **One answer per question** — you can't change it once you've clicked.
- Get it right and your name joins the public **"Correct so far"** list on the question,
  and you earn a point. You have **1 hour** to answer before the question closes.

### `/qna`

```
/qna
```

Shows the **top 10 quiz scorers** publicly, with points and correct/wrong counts.
Answer more questions to climb the board.

---

## 4. Your Profile

```
/profile
/profile user:@SomeoneElse
```

Shows a profile card publicly (defaults to **you**; add the optional `user` option to
view someone else). It pulls together:

- Username and in-game name
- **Kudos** received, your rank, and how many you've given today
- **Job class**, **power**, and your **party name + party members** (per guild, if
  you're in both Daddy and Mummy)
- Member-since date

If some data isn't available (e.g. you're not on the roster yet) the card still shows
what it can.

---

## 5. Guild Roster

```
/guildroster
/guildroster guild:Mummy
```

Posts the guild roster as **images**, one per raid group, so you can see how parties
are organized. The `guild` option picks **Daddy** (default) or **Mummy**. Posted
publicly.

---

## 6. Game Database Lookups

Look up game data straight from Discord. Each is a slash command with **autocomplete** —
start typing and **pick a suggestion**. All post publicly. Data is from roworlddb.com.

| Command | Use it to look up… |
|---|---|
| `/monster <name>` | A monster's stats, element, race, and drop rates |
| `/item <name>` | Equipment stats, effects, refine bonuses, and job limits |
| `/card <name>` | A card's effect, equip slot, and which monsters drop it |
| `/map <name>` | A map's region, minimap, and known monster spawns |
| `/skill <name> [class]` | A skill's effect, SP cost, cooldown, and levels — add `class` to narrow suggestions |
| `/rune <name>` | A rune's per-level bonuses and element resonance |
| `/refine [level]` | Refine odds and materials — one level, or leave blank for the full +0→+20 table |
| `/pet <name>` | A pet's rarity, combat skills, owner buffs, and battle stats |
| `/shop <name>` | Which NPC shop sells something, its price, and limits |

**Example:** type `/monster`, then start typing `edd` and pick **EDDGA** from the
suggestions.

---

## 7. Guild Application

```
/guildapplication
```

Posts the **Guild Application** prompt (with a **Start Application** button) into the
channel. Anyone who should apply clicks **Start Application** and fills in a short form:

- **In-game Name** (required)
- **Playstyle** (required)
- **Previous Guild (CBT)** (optional)
- **Inviter** (optional)

After submitting, you get an ephemeral "✅ Application submitted — pending approval"
confirmation. Leadership reviews it, and you'll receive a **direct message** with the
outcome. Please be patient.

---

## 8. Reacting to Leadership Posts

Some things are **set up by leadership**, but *you* interact with them:

### Guild Expedition sign-up (reaction role)

When leadership posts the **🗺️ Guild Expedition Sign-Up** embed, **react with ✅** to
give yourself the **Guild Expedition** role. **Remove your reaction** at any time to
drop the role. That's the whole thing — no command needed. (This keeps working even
after the bot restarts.)

### Activity / launch check

If leadership posts a launch or activity check (a message with **✅ Yes** / **❌ No**
buttons), just click the button that fits. You get a quiet, private acknowledgement, and
you can **change your answer** within the same week.

### Applying to a job ad

When leadership posts an **officer recruitment ad**, it has an **Apply** button. If
you're eligible (a guild member), click **Apply**, fill in the short form (your IGN and
why you're a good fit), and submit. Your application goes to leadership for review.

---

## 9. Utility

### `/help`

```
/help
```

Lists the commands you can use, grouped by category and **tailored to your roles**
(you only see what you can actually run). Ephemeral — only you see it.

### `/ping`

```
/ping
```

Checks that the bot is online and shows its response time. Handy if things seem slow.

---

## 10. Tips & FAQ

- **"Only you can see this" replies** are normal — that's an ephemeral message. It's not
  broken; it just isn't posted publicly.
- **Party Finder times are always Server time (GMT+7).** The "in X minutes" text updates
  itself live.
- **Role counts must equal party size.** If Tank + Heal + DPS doesn't add up to your
  party size, the bot asks you to restart and fix it.
- **Can't join a party as a certain role?** Your **class** decides which roles you can
  take. The bot always tells you which roles you're allowed.
- **Kudos not working?** You get **7 per day** (resets midnight GMT+7), you can't kudos
  yourself or bots, and your message must start with `kudos` and mention someone.
- **Quiz question disappeared?** Questions run for **1 hour** then close automatically —
  answer promptly. You can only answer once.
- **Only carriers can answer carry requests.** Responding to a carry needs the **Carry**
  role; creating one just needs Party Finder access.

---

*Some commands are leadership-only (setting up expeditions, GvG schedules, campaigns,
and other admin tooling) and aren't covered here — this guide is everything a regular
member needs. When in doubt, run `/help` to see exactly what's available to you.*
