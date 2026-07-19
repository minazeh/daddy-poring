# Guild Event Reminder — Build Spec (frozen 2026-07-19)

Owner: Conrad · Orchestrated by Nanna · Built by Kai
Status: **Approved — build phase by phase. Do not deviate without Nanna's sign-off.**

> Terminology: user-facing copy always says **"Guild Event"**, never "GvG". (Internally
> these are still the `gvg_schedules` docs / `gvg/*` modules — only the *displayed text* changes.)

---

## 1. What this is

A silent, self-bumping **Guild Event reminder** that appears **2 hours before** each scheduled
event with **Let's go! / Can't make it** buttons, records RSVPs efficiently, maintains a **live
tally** in a separate channel, and feeds the "can't make it" list into the **web-app party
builder** (grey-out + deprioritize).

Two building blocks already exist and MUST be reused, not reinvented:
- **`gvg/scheduler.js`** — `nextOccurrence(day, time)` already converts a weekly **GMT+7**
  wall-clock slot to a precise UTC instant. "2h before" = `nextOccurrence(...) − 2h`. **No new
  timezone math.**
- **`activitycampaign/sticky.js`** — the "keep a message pinned to the bottom of the channel"
  engine (repost-on-messageCreate, debounced, restart-safe via Mongo). Model the reminder sticky
  on this, but **time-bounded + per-event** (the campaign one is a single always-on global).

Architecture note: the **bot and the web app share the same Atlas cluster / `MONGODB_URI` /
`discordbot` database**. "Passing data to the web app" = the bot writing a shared Mongo
collection the web app reads. **No HTTP API.**

---

## 2. Channels (hard-coded IDs)

| Purpose | Channel ID |
|---|---|
| **Reminder + buttons** (Channel A) | `1518082956466585731` |
| **Live tally** (Channel B) | `1528279089629106196` |

---

## 3. Shared data contract — `gvg_attendance_intent`

New collection in the `discordbot` DB. One doc per member-per-occurrence:

```
{
  occurrenceKey: string,   // `${scheduleId}:${eventDateISO}` — unique per event per week
  scheduleId:    string,   // source gvg_schedules _id
  guild:         "daddy" | "mummy",  // the RESPONDER's roster affiliation (see §7)
  userId:        string,
  displayName:   string,   // snapshot for the tally / .txt (roster lookup at press time)
  response:      "yes" | "no",
  eventAt:       Date,     // event start (UTC) — for the web app's "upcoming occurrence" query
  updatedAt:     Date,
}
```

- **Upsert key:** `(occurrenceKey, userId)` — a member changing their mind overwrites.
- `occurrenceKey` embeds the event date, so **each week & each event is a fresh set** — last
  week's answers never bleed in, no cleanup job needed.

Index: `{ occurrenceKey: 1, userId: 1 }` unique; plus `{ guild: 1, eventAt: 1 }` for the web app.

---

## 4. Occurrence identity & multiple events/week

- There are **multiple events per week**. Each `gvg_schedules` doc is an independent weekly event.
- An **occurrence** = one firing of one schedule = `scheduleId` + that firing's event date (in GMT+7).
- Each occurrence has: its own reminder sticky (Channel A), its own tally message (Channel B),
  its own `occurrenceKey` intent set.

---

## 5. Phase 1 — Reminder sticky + buttons + RSVP recording

New module: **`gvg/reminder.js`** (+ constants as needed; may extend `gvg/constants.js`).

### 5.1 Reminder message (Channel A)
- **Silent** — `allowedMentions: { parse: [] }`, no pings ever.
- Content (tweak wording lightly for engagement, keep short):
  > ⚔️ **Adventurers!** Guild Event **{label}** kicks off <t:{unix}:R> (<t:{unix}:F>). Are you in?
- Two buttons, one row:
  - `[⚔️ Let's go!]` — Success style — customId `gvgrsvp:yes:{occurrenceKey}`
  - `[😔 Can't make it]` — Secondary style — customId `gvgrsvp:no:{occurrenceKey}`
  - **customId ≤ 100 chars** — `occurrenceKey` is `scheduleId(ObjectId hex, 24)` + `:` + a
    compact date (e.g. `YYYYMMDD`). Well under 100. Verify.

### 5.2 Sticky behavior
- Reuse the campaign's repost-on-messageCreate + debounce pattern so the reminder stays the
  newest message in Channel A. Reposting deletes the bot's own prior message and sends a fresh
  one — **RSVP state lives in the DB/memory keyed by occurrence, NOT on the message**, so reposts
  never lose responses.
- **Multiple concurrent reminders:** if two events are both inside their reminder window at once,
  both stickies coexist in Channel A and each bumps on new chat. (Rare — events are normally on
  different days. Do NOT merge; keep them independent.)

### 5.3 Timing (arm / take-down)
- **Reminder-start = `max(now, eventAt − 2h)`.** If an event is set **less than 2h out** (or the
  computed start is already past but the event is still future), post the sticky **immediately**
  with the correct live countdown.
- **Take-down = at event start** (`eventAt`), BEFORE attendance capture begins. Deletes the
  sticky from Channel A and triggers the final RSVP flush (§6).
- Wire into `gvg/scheduler.js` alongside the existing capture timer: arming a schedule arms
  (a) the reminder-start timer, (b) the take-down timer, (c) the existing capture timer.
  `armAll()` on boot re-arms all three for every schedule so **restarts are safe**. Timers
  `.unref()` like the existing ones.
- A reminder-start timer whose time is already past at arm time fires immediately (delay clamped
  to ≥0, same pattern as `armSchedule`).

### 5.4 RSVP recording
- On button press: **ephemeral** ack — "You're in! ⚔️" (yes) / "Marked as can't-make-it — change
  it anytime" (no). Look up the presser's `displayName` + guild affiliation from roster (§7).
- Hold the response in an **in-memory map** keyed by `occurrenceKey → userId → {response, guild,
  displayName}`. **No per-press DB write** (batched — §6).
- Idempotent: re-press just overwrites the in-memory entry.

### 5.5 Delete-mid-window handler (CRITICAL)
- `/gvgschedule remove` on a schedule whose reminder is currently active MUST:
  1. Cancel the reminder-start + take-down timers (extend `scheduler.cancelSchedule`).
  2. **Delete the sticky** from Channel A.
  3. **Final-flush** the in-memory RSVPs for that occurrence to Mongo.
  4. **Annotate the Channel-B tally** as **"⚠️ Event removed"** and leave it (retained, not deleted).
- Never throw into the command path; graceful-degrade if Channel A/B or DB is unreachable.

---

## 6. Phase 2 — Batched sync + live tally (Channel B)

### 6.1 Batched sync (anti-overload)
- A **10-second** interval flush: coalesce the in-memory RSVP map and write via a **single
  `bulkWrite` upsert** (matches the web app's `bulkWrite({ordered:false})` idiom). A burst of 400
  taps in one window = **one** write.
- Only flush occurrences with dirty entries.
- **Guaranteed final flush** on: (a) event start / take-down, (b) delete-mid-window. This is what
  makes the <2h / short-window case safe (the 10s timer may never fire before take-down otherwise).
- Graceful-degrade: DB down → keep buffering in memory, retry next tick; never crash.

### 6.2 Live tally (Channel B) — **embed + `.txt`**, retained, one message per occurrence
- On first flush for an occurrence, **post** the tally message; thereafter **edit it in place** on
  each flush where counts changed. **New event / new week = a NEW message** (old ones retained
  untouched — Channel B is a running archive).
- **Embed** (segregated **Daddy / Mummy**):
  - Header: event label + `<t:{unix}:R>` countdown.
  - Per guild: `✅ {N} going · 😔 {M} can't`.
  - Per guild: the **full "Can't make it" name list inline** (paginate across fields if it ever
    overflows — reuse the attendance-log paginator limits in `gvg/constants.js`).
  - "Going" shown as a **count only** (not the full list — that's in the `.txt`).
  - Footer: "Full roster & party view in the app."
- **`.txt` attachment** — `guild-event-{label-slug}-{date}.txt`: the **complete** segregated
  record (all Going + all Can't names, per guild). **Refreshed on each flush** (re-uploaded via
  message edit so it stays current) and **finalized at event start**.
- **400-member scale:** single editable message; `.txt` carries the full ~800 names; embed shows
  counts + the (usually small) can't-list. Reuse the existing paginator constants; never exceed
  Discord caps (1024/field, 25 fields, 6000/embed, 10 embeds/msg, 2000/content).
- Tally state (message IDs per occurrence, in Channel B) persisted in Mongo so edits survive
  restarts (mirror the campaign's config-in-Mongo pattern).

---

## 7. Guild segregation (Daddy vs Mummy)

- A responder's guild = roster affiliation (`roster/db.js`: `isMain` ⇒ Daddy, `isSub` ⇒ Mummy).
  A member in **both** is counted under **both** sections.
- **Schedule `guild` field** scopes the event:
  - `daddy` / `mummy` → tally shows only that section; only that guild's members are relevant.
  - `both` → **one** reminder in Channel A; the tally embed shows **both** Daddy and Mummy sections;
    each responder lands in the section(s) matching their roster affiliation.
- The web app (Phase 3) already toggles Daddy/Mummy — it filters intent by the shown guild.

---

## 8. Phase 3 — Web-app consumption (party builder)

**Occurrence discovery (RESOLVED — the "both"-member fix, no schema change):** do NOT filter the
intent by its `guild` field (a `both` member is stored once as `daddy`, so a guild filter would
miss them). Instead:
1. Read `gvg_attendance_intent` docs with `response:"no"` and `eventAt >= now`.
2. Group by `occurrenceKey`; resolve each occurrence's TRUE guild from its **schedule**
   (`scheduleId` → `gvg_schedules.guild`), not from the intent's collapsed `guild`.
3. Keep occurrences whose **schedule guild ∈ { shownGuild, 'both' }**; pick the **soonest** `eventAt`.
4. Return the **Set of `userId`s** with `response:"no"` for that occurrence.
A `both`-member's single "no" doc then correctly greys them in BOTH the Daddy and Mummy views,
because matching is by `(occurrenceKey, userId)`, and both views resolve to the same `both`-event
occurrence. Graceful-degrade to an empty set when Mongo is unconfigured/unreachable.

**Where it applies:** the party **builder** (home page `/` → `BuilderShell` → `MemberPool` +
`MemberChip`). Thread an `unavailableIds: Set<string>` from `page.tsx` down through `BuilderShell`
to `MemberPool` and to every `MemberChip` (pool AND in-party).

- Members who responded **"no"** → **greyed/dimmed** wherever they render (pool + party slots,
  including `locked`/fixed members), and in the **member pool** sorted to the **bottom**
  (deprioritized beneath the existing sort — unavailable always sink last regardless of sort mode).
  They stay **draggable** (grey is de-prioritization, not a block).
- Members already **assigned to a party** ("fixed"/locked) → **greyed only, position unchanged**.
- **"yes"** and **no-response** members render normally. Only an explicit "no" greys.
- Intent auto-resets per occurrence, so greys clear when the next event's window opens.
- **New Next.js quirk:** this repo's `AGENTS.md` warns the Next.js APIs differ from training data —
  read the relevant guide under `node_modules/next/dist/docs/` before writing; preserve the strict
  SSR-hydration determinism (default order server-computed; only user interaction re-sorts).

---

## 9. Verification bar (every phase)

- `node --check` green on every touched/new `.js`.
- Boot simulation: modules load, events/commands register, with + without `MONGODB_URI`.
- customId length < 100 verified.
- Timing math unit-checked: `max(now, event−2h)`, take-down at event start, re-arm on boot,
  delete-mid-window teardown.
- Live token-gated bits (actual posting, button presses, DB writes) need Conrad's Railway test —
  document what's verified vs. what needs a live pass. **Nothing committed/pushed** — stage for
  Nanna's review.

---

## 10. Phasing

1. **Phase 1** — reminder sticky + buttons + in-memory RSVP recording + scheduler timers +
   delete-mid-window teardown. (Tally can be a stub/no-op until Phase 2.)
2. **Phase 2** — 10s batched sync to `gvg_attendance_intent` + the Channel-B tally (embed + `.txt`).
3. **Phase 3** — web-app grey-out + deprioritize.

Each phase: build → verify → **stage for Nanna review** → Conrad sign-off → next phase.
