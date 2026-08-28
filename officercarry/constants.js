// ---------------------------------------------------------------------------
// Shared constants for the officer carry scheduler.
//
// Spec: docs/OFFICER_CARRY_SCHEDULER_SPEC.md
//
// THIS FEATURE HANDLES NO MONEY. It shares the panel-plus-ephemeral shape with
// the Final Mirage carry-sales system and nothing else: no prices, no seats, no
// bookings ledger, no Mark Paid step, and NO PENDING STATE. A member who
// presses Join is in the slot at that instant (spec §0). The only things that
// can refuse a join are the slot being full, having no officer on it, or the
// member already being on it — and all three are decided by the single
// conditional update in db.claimMemberSlot().
// ---------------------------------------------------------------------------

const { GODFATHERS_ROLE_ID, TICKET_OFFICER_ROLE_IDS } = require('../ticket/constants');

// ---------------------------------------------------------------------------
// customId namespace: `occarry:`. Checked free against all eleven existing
// routers in events/interactionCreate.js.
//
// RESTART SAFETY: the three PANEL ids are STATIC — a board posted in March
// still works in September because nothing about it is held in memory. Every
// id past the panel carries the day (and where needed the slot key), so a
// restarted process rebuilds full context from the click alone.
//
// Flow chain:
//   occarry:join                     panel "Join a slot" button
//   occarry:joinday                  ephemeral day select
//   occarry:joinslot:<day>           ephemeral slot select
//   occarry:avail                    panel "I'm available" button (officers)
//   occarry:availday                 ephemeral day select
//   occarry:availslot:<day>          ephemeral slot select
//   occarry:mine                     panel "My slots" button
//   occarry:leave:<slotKey>          leave a slot as a member
//   occarry:owithdraw:<slotKey>      officer withdraw, first press (may warn)
//   occarry:owithdrawc:<slotKey>     officer withdraw, confirmed
// ---------------------------------------------------------------------------
const IDS = {
  JOIN_BUTTON:      'occarry:join',
  JOIN_DAY:         'occarry:joinday',
  JOIN_SLOT:        'occarry:joinslot',    // occarry:joinslot:<day>
  AVAIL_BUTTON:     'occarry:avail',
  AVAIL_DAY:        'occarry:availday',
  AVAIL_SLOT:       'occarry:availslot',   // occarry:availslot:<day>
  MINE_BUTTON:      'occarry:mine',
  LEAVE:            'occarry:leave',       // occarry:leave:<slotKey>
  OFFICER_WITHDRAW: 'occarry:owithdraw',   // occarry:owithdraw:<slotKey>
  OFFICER_WITHDRAW_CONFIRM: 'occarry:owithdrawc',
};

const NAMESPACE = 'occarry:';

// ---------------------------------------------------------------------------
// Channels. Env-overridable so a test server can be pointed elsewhere without a
// code change; the literal is the live guild's id (Conrad, 2026-08-28).
// ---------------------------------------------------------------------------
const CHANNELS = {
  PANEL: process.env.OFFICERCARRY_PANEL_CHANNEL_ID || '1542751918542164019',
};

// ---------------------------------------------------------------------------
// Permissions. Same officer set as tickets and carry sales — imported rather
// than re-listed, so a role change lands in one place.
//
// NOTE inherited from ticket/constants.js: three of these seven ids appear
// nowhere else in the repo and could not be name-checked. A wrong id fails
// SILENTLY here too — that role simply can't mark availability.
// ---------------------------------------------------------------------------
const OFFICER_ROLE_IDS = TICKET_OFFICER_ROLE_IDS;

// ---------------------------------------------------------------------------
// The grid (spec §2). Times are GMT+7 — the offset gvg/constants.js already
// uses across GvG schedules and attendance logs. The bot speaks ONE timezone
// and this feature deliberately does not introduce a second.
// ---------------------------------------------------------------------------
const TZ_OFFSET_HOURS = 7;
const TZ_LABEL = 'GMT+7';

const SLOT_MINUTES = 30;

// Windows are [start, end) in minutes from midnight. 00:00 is the exclusive end
// of the day's window, so the last slot of every day starts 23:30.
const WEEKDAY_WINDOW = { startMin: 18 * 60, endMin: 24 * 60 };  // 18:00 -> 00:00, 12 slots
const WEEKEND_WINDOW = { startMin: 12 * 60, endMin: 24 * 60 };  // 12:00 -> 00:00, 24 slots

// Monday-first, matching the board and the week boundary.
const DAYS = [
  { key: 'mon', label: 'Mon', weekend: false },
  { key: 'tue', label: 'Tue', weekend: false },
  { key: 'wed', label: 'Wed', weekend: false },
  { key: 'thu', label: 'Thu', weekend: false },
  { key: 'fri', label: 'Fri', weekend: false },
  { key: 'sat', label: 'Sat', weekend: true  },
  { key: 'sun', label: 'Sun', weekend: true  },
];

// Members per slot (spec §1). Officer availability is UNCAPPED.
const MAX_MEMBERS_PER_SLOT = 3;

// ---------------------------------------------------------------------------
// Sweeper. Five minutes is well inside any reasonable tolerance for a weekly
// boundary and costs one indexed query per tick.
// ---------------------------------------------------------------------------
const SWEEP_INTERVAL_MS = 5 * 60 * 1000;

// Panel re-render debounce (spec §7.2). State is committed to Mongo
// IMMEDIATELY and always; only the visual refresh is debounced, so a coalesced
// edit can never mean a lost join.
const PANEL_DEBOUNCE_MS = 1_500;

// ---------------------------------------------------------------------------
// Discord limits the renderer must respect (spec §7.3). Asserted rather than
// assumed — an oversized embed is rejected outright and would freeze the board.
// ---------------------------------------------------------------------------
const EMBED_FIELD_VALUE_LIMIT = 1024;
const EMBED_TOTAL_LIMIT = 6000;
const SELECT_OPTION_LIMIT = 25;

const COLORS = {
  PANEL: 0x5865F2,
  OK:    0x57F287,
  WARN:  0xFEE75C,
  ERROR: 0xED4245,
};

// Fill indicators on the board. Filled = a member is in that space.
const DOT_FILLED = '●';
const DOT_FREE = '○';

const PANEL_TITLE = 'Officer Carry — Weekly Schedule';

module.exports = {
  IDS,
  NAMESPACE,
  CHANNELS,
  GODFATHERS_ROLE_ID,
  OFFICER_ROLE_IDS,
  TZ_OFFSET_HOURS,
  TZ_LABEL,
  SLOT_MINUTES,
  WEEKDAY_WINDOW,
  WEEKEND_WINDOW,
  DAYS,
  MAX_MEMBERS_PER_SLOT,
  SWEEP_INTERVAL_MS,
  PANEL_DEBOUNCE_MS,
  EMBED_FIELD_VALUE_LIMIT,
  EMBED_TOTAL_LIMIT,
  SELECT_OPTION_LIMIT,
  COLORS,
  DOT_FILLED,
  DOT_FREE,
  PANEL_TITLE,
};
