# Final Mirage Carry Sales — Scope

**Status:** **BUILT 2026-08-24 (Kai). Revised 2026-08-31 (Priest seat removed) and
2026-09-02 (heard-from field, §7.1 — in the working tree, NOT committed, NOT pushed).**
Deploying is Conrad's call. See §13.1–13.3 for the env vars, the decisions taken
at build time, and the retirement mechanism.
**Replaces:** `/partyfinder` (retired by unregistering it; every file kept on disk)
**Date:** 2026-08-24

---

## 1. What this is

A paid-slot booking system for selling Final Mirage carries. A public sales panel
takes a buyer through tier → timeslot → payment method, holds the seat for 30
minutes, and an officer confirms payment to make it stick. Two auto-updating
boards — one public showing run occupancy, one officer-only showing unpaid holds.

This is the first feature in this bot that handles **money**, which drives two
design departures from `/partyfinder` (see §4).

---

## 2. IDs supplied

| Purpose | ID |
|---|---|
| Sales panel channel | `1541160645292982373` |
| Public schedule board | `1527144922812121118` |
| Pending-payment board (officer) | `1541159719266156697` |
| Godfathers (run admin) | `1518076150692188200` |
| Officers (mark paid) | `TICKET_OFFICER_ROLE_IDS` (ticket/constants.js:45) |

**Payment account details are NOT in this repo — and not in the environment
either.** The bot holds no account numbers at all. A buyer who books is DM'd a
clickable mention of the **runner** (the run's creator) and told to message them
to arrange payment. The repo is public; there is nothing payment-shaped in it to
leak. See §7 step 7.

---

## 3. Product

| Tier | Price | Slots | Class requirement |
|---|---|---|---|
| Guaranteed SS | $5 / slot | 4 | None — any class |
| Guaranteed SSS | $10 / slot | 3 | None — any class |

Payment methods offered: GCash, Bank Transfer, Wise, PayPal. The buyer picks
one, but **no account details are attached to any of them** — the pick is a hint
recorded on the booking and shown to the runner and on the pending board, so the
runner knows what is coming before the buyer messages them.

**Every seat is open to every class** (Conrad, 2026-08-31). There was
previously a Priest-only seat — the last seat of each tier — with a
self-declaration step behind it and a wrong-class refusal in front of it. All of
that is removed. **Slot counts are unchanged**, so the seat that used to be
Priest-only is now simply sellable to anyone, and the buyer's roles are never
read at any point in the flow.

---

## 4. The two departures from `/partyfinder`

### 4.1 Mongo is authoritative, not the in-memory Map

`partyfinder/state.js` keeps the in-memory Map authoritative and mirrors to Mongo
fire-and-forget (`.catch()`-ed so a write failure can never fail a user
interaction). Correct trade for free party-finding; wrong one here. Railway
restarts on every deploy, and a mirror that lagged means a seat sold twice and a
refund owed.

Here the seat is claimed by **one conditional update** that asserts the seat is
still free and fails if it isn't:

```
updateOne(
  { _id: runId, 'seats.<n>.status': 'open' },
  { $set: { 'seats.<n>': { status: 'pending', ... } } }
)
```

`matchedCount === 0` means someone else took it — the buyer is told, and the
picker re-renders with that run's true state. The database enforces capacity, so
a deploy mid-purchase cannot double-sell and the design does not break if Railway
ever runs more than one instance.

The in-process guard from `partyfinder/handlers.js:722` (check and take with no
`await` between them) is still correct and is kept as the fast path.

### 4.2 Bookings are a permanent ledger, not delete-on-close

`partyfinder/db.js` **deletes** party docs on close to avoid accumulating cruft.
Right for throwaway cards, wrong for sales records. Bookings are never deleted.
Every booking keeps buyer identity, IGN, how they heard about the service
(§7.1), tier, price, chosen payment method, the
run it was for, and a timestamped status history (`pending → paid → completed`,
or `→ released` / `→ cancelled`). Releases and cancellations are status
transitions, not deletions.

This also gives per-run and per-period revenue reporting for free later.

---

## 5. Class requirements — there are none

**Removed 2026-08-31 (Conrad): "remove the priest slot and instead open it up
for all classes."**

This section previously described a Priest-only seat and the self-declaration
workflow needed to sell it to outside buyers, who arrive with no class role
because class roles are not self-assignable. That whole conflict is gone along
with the requirement that created it. **No seat is class-gated, the buyer's
roles are never read, and there is nothing for an officer to verify at Mark Paid
beyond the payment itself.**

**No migration was run.** Runs created before the change still carry
`priestOnly: true` on their last seat in Mongo, and bookings written before it
still carry `priestSeat` / `declaredPriest` / `priestRoleVerified`. Nothing
reads any of those fields any more — `selectSeat` deliberately ignores
`priestOnly`, which is what makes an already-open run's last seat sellable to
anyone the moment the change deploys. The booking ledger is append-only in
spirit (§4.2), so the historical flags are left exactly as they were rather than
being rewritten.

---

## 6. Runs

**Runs are created and removed manually. There is no recurring template and no
auto-rollover** (Conrad, 2026-08-24).

`/carryrun` — Godfathers only:

| Subcommand | Effect |
|---|---|
| `create <tier> <datetime>` | Opens a run, posts its board message |
| `delete <run>` | Removes the run and its board message |
| `close <run>` | Stops accepting joins, board message stays |
| `edit <run> <datetime>` | Reschedules, board message updates in place |

`create` takes tier and date/time; capacity follows from the tier, so it is
never entered by hand and can't drift from §3.

A run's board message is **left in place after its start time passes** — no
auto-archive. It stops accepting joins and is restyled as concluded.

### 6.1 `delete` versus the ledger

Deleting a run must not destroy sales records (§4.2). `delete` removes the run
and its board message; **bookings against it are retained** and marked
`run_deleted`.

Guard: `delete` **refuses** when the run has any `paid` booking, and says how
many. Those are people who have handed over money — removing their run silently
is exactly the failure this system exists to avoid. Clear them first with the
per-booking **Cancel** action (officer-only, on the board — §7), which is
deliberate and leaves a record, then delete. `delete` proceeds freely when only
`pending` or `released` bookings exist.

Note the two are different verbs on different objects: **Cancel** acts on one
buyer's booking and is the only way to void a paid seat; **delete** acts on the
run and is blocked while any paid seat survives.

---

## 7. Flow

1. **Panel** posted once to `1541160645292982373` — the sales copy plus a
   **Pick your slot** button. Static; survives restarts because it holds no state.
2. **Tier select** (ephemeral) — Guaranteed SS $5 / Guaranteed SSS $10.
3. **Timeslot select** (ephemeral) — open runs of that tier only. **Full runs are
   filtered out**, so a full run cannot be picked in the first place; the
   conditional take in §4.1 is the backstop for the race, not the primary guard.
4. **Booking details** (modal, "Your booking details") — two required fields on
   one form: the buyer's **IGN**, and **where they heard about the service**
   (§7.1). Both are recorded on the booking.
5. **Payment method select** — GCash / Bank Transfer / Wise / PayPal.
6. **Seat goes PENDING.** Buyer is DM'd a **clickable `<@id>` mention of the
   runner** — the run's creator (`run.createdBy`, stamped by `/carryrun create`)
   — and told to DM them to arrange payment, naming the method they picked. The
   DM also carries the booking id, the price, the run label and the hold
   countdown. **No account details pass through the bot.** If the run has no
   resolvable creator, the buyer is told an **officer will follow up** instead;
   a broken mention is never rendered. Public board updates to show the seat
   held. An entry appears on the pending board.
7. **Officer clicks Mark Paid** → seat confirmed, boards update.
   **30 minutes elapse without payment** → seat auto-releases, boards update, the
   slot is open again.

Cancellation of a confirmed seat is **officer-only**. Buyers cannot self-release.

### 7.1 "Where do you hear the service?" (added 2026-09-02)

Conrad, 2026-09-02: *"in the modal I want to add a field 'Where do you hear the
service? (FB Group, YouTube, Person, Etc.)' this goes alongside the IGN and
all."* It is marketing attribution — which channel is actually producing sales.

| Point | Resolution |
|---|---|
| **Where it sits** | Second row of the same modal, below the IGN. The modal is retitled **"Your booking details"** since it no longer asks only for a name. |
| **The wording** | Discord caps a modal input **label at 45 characters** and the full question is 64, so it is split rather than paraphrased: label `Where do you hear the service?`, placeholder `FB Group, YouTube, Person, Etc.` |
| **Required** | Yes. Short input, 100-character cap (`HEARD_FROM_MAX`). |
| **Stored as** | `heardFrom` — the same name in JS, on `seats.<i>` and on the booking doc. Carried modal → draft → `claimSeat` → seat + ledger. Nulled on the seat by the release path exactly as the IGN is; the **booking keeps it forever** (§4.2). |
| **Who sees it** | **Officers only** — the pending board, immediately beside the IGN. It is deliberately **not** on the public run board and **not** in anything the buyer receives, including the confirmation echo after the modal. How a buyer found us is not other buyers' business. |
| **No migration** | Bookings and open runs already in Mongo have no `heardFrom`. They are left exactly as written (§4.2, same treatment as the Priest flags in §5). Absent and null both render as *Not recorded* — never a blank, never the text "null" or "undefined". |

**Deploy safety — the one thing that could have cost a sale.** A buyer can open
the modal seconds before this deploys and submit it seconds after. That
submission carries no heard-from input, and `getTextInputValue()` **throws** on
an absent custom id rather than returning `undefined`, which would take the
handler out mid-purchase. It is therefore read through `readOptionalField()` in
`carry/handlers.js`, which returns `null` when the field is absent, and **the
booking proceeds with `heardFrom: null` rather than the sale being refused**.
Any field added to this modal in future must be read the same way.

A whitespace-only answer is a different case — the field *was* on the form — and
is refused with a re-prompt, exactly as an empty IGN is.

---

## 8. Boards

**Public board** (`1527144922812121118`) — one message per run, edited in place
on every state change. Shows tier, date/time, filled/total, seat occupants, the
class requirement (none), and the **runner as a mention** — buyers see who they will
be paying before they book. One message per run rather than a single master embed:
cheaper edits, no rewrite races, and it never hits the 25-field embed cap once
several runs are live at once.

**Pending board** (`1541159719266156697`) — officer-facing. One entry per unpaid
hold: buyer, IGN, **where they heard about the service** (§7.1 — officer-only,
never on the public board), tier, run, chosen payment method, **the runner as a mention**
(whose DMs the money is going to), countdown to auto-release, and **Mark Paid**
/ **Release** buttons.

Both boards' message IDs are persisted so edits survive a restart.

---

## 9. Files

New module, nothing deleted:

```
carry/constants.js    IDs, tiers, pricing, copy, payment-method labels
carry/db.js           carry_runs + carry_bookings, own MongoClient
carry/state.js        seat claim/release, conditional take
carry/handlers.js     panel, pickers, modals, officer buttons, board rendering
carry/resume.js       rehydrate boards + pending timers on boot
commands/carrypanel.js   post the sales panel (Godfathers)
commands/carryrun.js     create / delete / close / edit (Godfathers)
```

`/partyfinder` is **retired by removing its registration only** — `commands/partyfinder.js`
and the `partyfinder/` module stay on disk, untouched and reversible. No deletions
(handbook §1.1).

Estimated 1,200–1,600 lines, comparable to the ticket system.

---

## 10. Restart durability

- Panel is stateless — survives trivially.
- Run and booking state lives in Mongo and is authoritative, so nothing is lost.
- `resume.js` re-attaches board messages by persisted message ID and **re-arms
  the 30-minute release timers** from `pendingUntil` timestamps. A hold that
  expired while the bot was down is released on boot rather than hanging forever.

---

## 11. Edge cases handled

- Two buyers taking the last seat simultaneously — conditional take, loser is
  told and re-shown true state.
- Deploy mid-purchase — pending holds and their deadlines survive.
- Buyer leaves the server while holding a seat — hold still expires normally;
  booking record retained.
- Officer marks paid after auto-release — refused with a clear reason, seat may
  have been resold.
- Buyer picks a run whose only free seat used to be the Priest seat — **sold
  normally, whatever their class.** A run created before 2026-08-31 still has
  `priestOnly: true` on that seat; it is ignored, not migrated.
- A modal or declaration button opened just before the 2026-08-31 deploy — the
  old customId shapes are no longer routed. The stale IGN form parses to a run
  id that cannot exist, so the buyer is told to start again and no seat can be
  claimed by it.
- A booking modal opened just before the **2026-09-02** deploy that added the
  heard-from field — the submit carries only the IGN. It is read through a safe
  accessor, so it does **not** throw: the seat is claimed normally and the
  booking records `heardFrom: null` (§7.1). Refusing that sale would have cost a
  paying buyer their place over our deploy timing.
- Board message deleted manually — re-posted on next state change, ID re-persisted.
- `/carryrun delete` on a run holding paid bookings — refused with the count, not
  silently destructive (§6.1).

---

## 12. Explicitly out of scope

- Taking payment. The bot never touches money; it records intent and an officer
  confirms.
- Refunds. Business process, not bot workflow.
- Buyer self-cancellation (officer-only per decision).
- Revenue reporting UI. The ledger supports it; no command is built for it yet.

---

## 13. Open items

**The runner must have DMs open to server members.** The whole payment route is
"buyer taps the runner's mention and messages them". A runner with DMs closed to
non-friends leaves the buyer with **no route to pay** — the seat is held, the
clock runs, and the hold lapses. The bot cannot detect this: Discord does not
expose another user's DM privacy setting, and the failure happens in the buyer's
client, not in any API call the bot makes. **Officers who create runs must be
told to enable DMs from server members**, and a buyer who reports being unable
to DM the runner needs an officer to step in before the 30 minutes are up.

Nothing else blocking. There is no payment configuration left to supply — the
DM step can be tested end to end as-is.

### 13.1 Environment variables (revised, Kai 2026-08-24)

**There are no payment variables.** Stored payment details were dropped before
launch (Conrad's call): the bot holds no account numbers in the repo or in the
environment, and points the buyer at the runner instead. The only carry
variables are optional channel overrides, read at import in
`carry/constants.js`.

| Variable | Holds |
|---|---|
| `CARRY_PANEL_CHANNEL_ID` | Optional override for §2's panel channel |
| `CARRY_BOARD_CHANNEL_ID` | Optional override for the public board |
| `CARRY_PENDING_CHANNEL_ID` | Optional override for the pending board |

**A run with no `createdBy` is a supported state.** It still sells: the seat is
held for the normal 30 minutes and the buyer is told an officer will follow up.
The bot never DMs a broken mention or an empty payment instruction.

### 13.2 Decisions taken at build time

Points the spec left implicit. None change a decision it made.

| Point | Resolution |
|---|---|
| **Which seat a buyer gets** | The flow (§7) has no seat picker, so seats are **assigned: lowest open seat first.** Since 2026-08-31 no seat is class-gated, so that is the whole rule — the only way seat resolution can fail is a full run. |
| **`create <datetime>`** | Taken as separate `date` (YYYY-MM-DD) and `time` (HH:MM) options, both GMT+7 — same information, but Discord gives each option its own hint text, which is what stops `30/08` and `8pm` arriving. Matches `/gvgschedule`. |
| **Run docs on `delete`** | The board message is deleted; the **run document is tombstoned (`status: 'deleted'`), not dropped**, because every booking in the ledger points at its `runId` and a dangling id would make the ledger unreadable. |
| **Terminal bookings on `delete`** | Only bookings still **live** (`pending`) transition to `run_deleted`. One that already ended `released` or `cancelled` keeps that status — overwriting it would falsify how it ended — but every booking for the run is stamped `runDeletedAt`/`runDeletedBy`. |
| **Who the buyer pays** | The **runner** — `run.createdBy`, the person who ran `/carryrun create`. Rendered as a `<@id>` mention in the buyer's DM and on both boards so it is tappable. Null `createdBy` (or a creator who no longer resolves) falls back to "an officer will follow up"; `<@null>` is never rendered. |
| **Keeping the payment-method select** | Kept when stored payment details were dropped (Kai's call, trivially reversible). It is one click, it already existed, and it tells the runner whether to expect GCash or PayPal before the buyer messages them. It carries no account data. |
| **Public board vs IGN** | The public board shows the occupant's **display name only**; the IGN appears on the officer pending board, which is where it is needed. The same rule governs `heardFrom` (§7.1). |
| **The modal's customId is unchanged** | The booking modal still submits as `carry:ign:<runId>:<seatIndex>` even though it is no longer only about the IGN. An already-open form will submit with the id it was built with, so renaming it would strand every buyer mid-purchase across the deploy for a cosmetic gain. `IDS.IGN_MODAL` keeps its name to match its value. |
| **Echoing the heard-from answer back** | The ephemeral step-4 confirmation echoes the buyer's IGN but **not** their heard-from answer. It is officer-facing data and the echo adds nothing the buyer just typed. Trivially reversible if Conrad wants it shown. |
| **Pending-board entries after resolution** | Edited in place to a final state with the buttons stripped, never deleted — the officer channel doubles as a log. |
| **Race losers and the ledger** | The two guards reject at different points and that is visible in the ledger: the in-process fast path rejects **before** any record is written (nothing happened to that buyer), while the conditional take rejects **after** the booking row exists — the row is written first so a crash mid-purchase leaves something recoverable — and that loser is on the ledger as `released`. |
| **Reschedule of a concluded run** | Moving a **concluded** run to a future time **reopens** it. A run an officer **closed by hand stays closed**; a reschedule is not a reversal of a deliberate act. |

### 13.3 Retirement mechanism

`/partyfinder` is retired by **one entry in `RETIRED_COMMANDS` in
`lib/registerCommands.js`**. Both registration paths (`events/ready.js` on every
startup, and `npm run deploy`) go through that function, so one line takes the
command off the server while `commands/partyfinder.js` and the whole
`partyfinder/` module stay on disk untouched. `index.js` still loads it into
`client.commands` and `events/interactionCreate.js` still routes its component
customIds, so **any party/carry card posted before the retirement keeps
working**. Deleting the line puts the command back.
