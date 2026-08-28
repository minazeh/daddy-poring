# Officer Carry Scheduler — `/officercarry`

**Status:** Spec, not built
**Date:** 2026-08-28

A permanent weekly scheduling board. Officers mark the half-hour slots they can
run a carry; members join a slot that has an officer on it. The board updates
itself on every change and rolls over to a fresh week automatically.

**There is no payment anywhere in this feature.** It shares nothing with the
Final Mirage carry-sales system beyond the panel-and-ephemeral-flow shape. No
prices, no seats, no bookings ledger, no officer Mark Paid step.

**And there is no pending state.** A member who presses Join is in the slot at
that instant. No hold, no expiry timer, no officer confirmation, nothing that
can be lost by someone forgetting to action it. The carry-sales system has a
30-minute hold and a Mark Paid step because money changes hands there; none of
that reasoning applies to a rota, so none of that machinery is here. The only
thing that can refuse a join is the slot being full, having no officer, or the
member already being on it, and all three are answered in the same instant by
the single database write in §5.1.

---

## 1. The model

Two sides, and they are not symmetric.

This is an **internal rota**, not a public sign-up. Both sides are staff.

| Side | Who | Action | Cap |
|---|---|---|---|
| **Runner** | **Godfathers only** | Marks a slot **Available**, which opens it | Uncapped. Several may sit on one slot |
| **Rider** | **Officers** | Presses **Join** on an open slot | **3 per slot** |

`GODFATHERS_ROLE_ID` is itself the first entry of `TICKET_OFFICER_ROLE_IDS`, so
`isOfficer()` is true for a Godfather too: a Godfather can still join a slot to
be carried by another. **The gate is one-directional on purpose** — an officer
who is not a Godfather can join but cannot open.

Both gates are checked twice, at the prompt and again at the commit, because an
ephemeral select can sit open across a role change and a customId is guessable.

**A slot with no runner on it cannot be joined.** Availability is what creates
a slot; joining only ever fills one that already exists. That ordering is the
whole design and it is why a member never books a run nobody can staff.

---

## 2. The grid

Monday to Sunday. Half-hour slots. All times **GMT+7**, matching
`gvg/constants.js` — the bot already speaks one timezone and this feature does
not introduce a second.

| Days | Window | Slots/day |
|---|---|---|
| Mon–Fri | 18:00 → 00:00 | 12 |
| Sat–Sun | 12:00 → 00:00 | 24 |

**108 slots per week.** The last slot of each day starts 23:30; 00:00 is the
exclusive end of the window, not a slot.

### 2.1 Why the board cannot be buttons

Discord allows 25 components per message (5 rows × 5). 108 slots is four times
that, so a button grid is not merely ugly, it is impossible.

The board is therefore a **read-only embed** plus a fixed button row, and every
pick happens in an ephemeral two-step flow. This falls out well: a select menu
caps at 25 options, and the largest day is 24 slots, so **any single day fits in
one select** with no paging.

---

## 3. Surfaces

### 3.1 The panel — one permanent message

Posted once by `/officercarry panel`, then never reposted. It is edited in place
for the life of the week and adopted again after a restart.

```
Officer Carry — Week of Mon 01 Sep  (GMT+7)

Mon 01 Sep          Tue 02 Sep
18:00 ●●○ Kaito     — no slots open —
19:30 ○○○ Ren

Wed 03 Sep          Thu 04 Sep
20:00 ●○○ Mei +1    — no slots open —
...

Sat 06 Sep
12:00 ●●● Kaito  FULL
14:30 ○○○ Ren

[ Join a slot ]  [ I'm available ]  [ My slots ]
```

Filled dots are members joined, hollow are free. `+1` means a second officer is
also on that slot. **Only slots an officer has opened are listed** — showing 108
mostly-empty rows would bury the ones that matter.

Member names are deliberately **not** on the panel. They live in the ephemeral
detail view. Seven days of names would blow the embed budget (§7.3) and the
board's job is at-a-glance availability.

### 3.2 Join flow (officers)

```
[ Join a slot ] → ephemeral
   → select a day        (7 options, days with no open slots are omitted)
   → select a time       (that day's open slots, ≤24 options)
   → joined, panel re-renders
```

The time select shows fill state and officer per option, so the choice is made
with the same information the board carries. Full slots are listed but disabled
in effect — selecting one returns "that slot filled up while you were choosing".

**Choosing the time is the commit.** There is no review screen and no confirm
button after it — the write happens on the select, and the ephemeral reply is
already the receipt. Two steps to join, both of them choices, neither of them a
formality.

### 3.3 Available flow (Godfathers only)

```
[ I'm available ] → ephemeral
   → select a day        (all 7)
   → select a time       (that day's full slot list, ≤24 options)
   → marked, panel re-renders
```

**Godfathers only**, via `GODFATHERS_ROLE_ID` imported from `ticket/constants`
exactly as `carry/constants` already does. An officer who is not a Godfather
gets an ephemeral refusal pointing them at **Join a slot**, and nothing else
happens.

### 3.4 My slots (anyone)

Ephemeral. Lists everything you are on this week, as a member and as an officer,
each with a Leave button. This is the only way to withdraw.

**An officer withdrawing from a slot that has members on it is warned, not
blocked** — it tells them how many people are affected and asks for a second
press. If they confirm and no other officer remains, the slot closes and joined
members are DMed that it was withdrawn. Silently stranding three people is the
failure mode worth spending code on.

---

## 4. Weekly reset

**Rolls at Monday 00:00 GMT+7.**

### 4.1 A sweeper, not a timer

Same reasoning as `ticket/sweeper.js`: a `setTimeout` aimed at next Monday dies
on the next Railway deploy, and this bot redeploys on every push. A week
boundary missed because someone shipped on Sunday night is exactly the bug that
would make the feature untrustworthy.

Instead a sweeper ticks every 5 minutes, computes the current week key from the
clock, and rolls if it differs from the active document's. **A bot that was down
over the boundary catches up on its first tick after boot.**

### 4.2 Rolling is an archive, not a delete

Nothing is deleted, per house pattern. The outgoing week's document is set
`status: 'archived'` and a fresh one is inserted. That leaves a real history of
who ran what and when, which is worth having and costs nothing.

The panel message is **edited into** the new week rather than reposted, so the
board keeps its permalink and does not spam the channel every Monday.

---

## 5. Data model

Collection `officercarry_weeks` in db `discordbot`, on its own `MongoClient`
like every other feature here.

```js
{
  _id:        'occarry:<guildId>:2026-W36',
  guildId, weekKey: '2026-W36',
  weekStartAt: Date,        // Mon 00:00 GMT+7, stored UTC
  weekEndAt:   Date,        // next Mon 00:00 GMT+7, exclusive
  status:     'active' | 'archived',
  panelChannelId, panelMessageId,
  slots: {
    'mon:1800': {
      officers: [ { userId, displayName, at: Date } ],
      members:  [ { userId, displayName, at: Date } ]
    },
    ...
  },
  createdAt, updatedAt, archivedAt
}
```

Slot keys are `<dayShort>:<HHMM>`, derived from the grid, never free text.

### 5.1 The 3-member cap is enforced by the database

Not by a length check in JavaScript. Two people pressing Join at the same
moment on the last free space is a real race, and Railway can run more than one
instance.

```js
updateOne(
  {
    _id: weekId,
    status: 'active',
    [`slots.${key}.officers.0`]:        { $exists: true  },  // an officer is on it
    [`slots.${key}.members.2`]:         { $exists: false },  // fewer than 3 joined
    [`slots.${key}.members.userId`]:    { $ne: userId    },  // not already joined
  },
  { $push: { [`slots.${key}.members`]: entry }, $set: { updatedAt: now } }
)
```

`matchedCount === 0` means one of those four conditions failed, and the handler
re-reads to tell the user which. One round trip, no read-then-write window.

`members.2` existing means length ≥ 3, so requiring it absent caps the push at
a third member. The officer guard is in the same filter deliberately: it closes
the window where an officer withdraws between a member opening the select and
choosing from it.

### 5.2 Degraded mode

If `MONGODB_URI` is unset or Atlas is unreachable, the bot boots fully and every
officercarry surface says the scheduler is unavailable. No in-memory fallback —
a schedule that evaporates on redeploy is worse than an honest refusal.

---

## 6. Restart safety

Railway redeploys on every push, so this is a first-class concern, not a
footnote.

| Thing | How it survives |
|---|---|
| Panel buttons | **Static customIds** (`occarry:join`, `occarry:avail`, `occarry:mine`). A panel posted in March still works in September |
| Ephemeral selects | Day and slot are carried **in the customId**, so a restart mid-flow still resolves from the click alone |
| The panel message | `panelMessageId` in Mongo, adopted on boot — edited, never reposted |
| Slot state | Mongo is authoritative. There is no in-memory slot map to go stale |
| The week boundary | Recomputed from the clock every sweep, not held in a timer |

Boot order in `events/ready.js`: `db.initSchema()` → `resume.adoptPanel()` →
`sweeper.start()`. None of them throw to the boot path.

---

## 7. Constraints that shape the implementation

### 7.1 Component and option caps
25 components per message; 25 options per select. The day-then-time split exists
to stay inside both, and the 24-slot weekend is the number that decides it.

### 7.2 Panel edit rate
Every join, leave and availability change re-renders the panel. A burst of
officers marking availability could hit Discord's edit rate limit.

**Debounced at 1.5s**, coalescing trailing edits, same shape as the sticky
engine's repost debounce. State is committed to Mongo immediately and always;
only the visual refresh is debounced, so a dropped edit never means a lost join.

### 7.3 Embed budget
Field value caps at 1024 characters and the whole embed at 6000. Worst case is
both weekend days fully open: 24 rows × ~28 chars ≈ 670 per field, ~3.5k total
across seven fields. Inside budget, but the renderer asserts it and truncates
the tail of a day with `…and N more` rather than letting Discord reject the edit
and freeze the board.

### 7.4 DM failure
Members with DMs closed cannot be told their slot was withdrawn. The DM is
best-effort and its failure is swallowed; the panel re-render is what everyone
actually reads.

---

## 8. Commands

| Command | Who | Does |
|---|---|---|
| `/officercarry panel` | Officers | Posts the board in this channel, or moves it here if one already exists |
| `/officercarry reset` | Officers | Forces a roll to a fresh week now. Archives, does not delete |

Registered through `lib/registerCommands.js` like everything else, so it appears
on the next boot with no manual command deploy.

---

## 9. Routing

`officercarry/handlers.js` exposes `route(interaction)` claiming **only** the
`occarry:` namespace and returning `false` for everything else, so it can sit
anywhere in the `events/interactionCreate.js` chain without risk. That namespace
is unused today — checked against all eleven existing routers.

---

## 10. Files

New module, nothing existing rewritten.

```
officercarry/constants.js    grid definition, ids, roles, timezone
officercarry/grid.js         slot keys, week keys, boundary maths — pure, no I/O
officercarry/db.js           own MongoClient, the conditional updates
officercarry/render.js       panel embed + ephemeral views
officercarry/handlers.js     route() and the interaction flows
officercarry/resume.js       boot-time panel adoption
officercarry/sweeper.js      weekly roll
commands/officercarry.js     slash command
scripts/sim-officercarry.js  offline simulation
```

Edited, additively only: `events/interactionCreate.js` (one router line),
`events/ready.js` (three boot lines), `lib/registerCommands.js` (registration).

**Nothing is deleted and no existing feature is touched.**

---

## 11. What the simulation must prove

Offline, no Discord connection, same approach as `sim-carry-system.js`.

1. **The grid is exactly 108 slots**, 12 on each weekday and 24 on each weekend day, last slot 23:30, no 00:00 slot.
2. **Week keys and boundaries** are correct across a month rollover, a year rollover, and the GMT+7 offset — a Sunday 23:30 GMT+7 slot must not land in next week.
3. **The 3-cap holds under a race.** Four concurrent joins on one slot yield exactly 3 winners and 1 refusal, with the in-process fast path disabled so the database is doing the work. **Negative control:** swapping the conditional update for read-then-write must over-fill, proving the test can detect the bug it is guarding.
4. **A slot with no officer cannot be joined**, including the case where the officer withdraws between the select opening and the choice.
5. **No double-join** by the same user on the same slot.
5b. **A join is immediate and final** — after the select resolves, the member is
    present in `slots.<key>.members` with no intermediate status, and there is
    no code path that can expire, release or un-commit it other than an explicit
    Leave. Asserted by searching the module for hold/pending/expiry machinery
    and finding none.
6. **Withdrawal**: last officer leaving closes the slot and flags joined members; a second officer remaining leaves it open.
7. **The roll archives rather than deletes** — the outgoing document still exists with `status: 'archived'` and its slot data intact.
8. **A missed boundary catches up**: simulate the bot down for three days across a Monday and assert the first tick rolls exactly once, not three times.
9. **Embed stays inside 1024/6000** in the worst case of every slot open and full.
10. **The whole bot still loads** — command count goes 30 → 31, all events present, no duplicate customId namespace.
