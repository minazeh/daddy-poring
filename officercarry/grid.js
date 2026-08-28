// ---------------------------------------------------------------------------
// The grid and the week boundary — PURE FUNCTIONS, NO I/O.
//
// Spec: docs/OFFICER_CARRY_SCHEDULER_SPEC.md §2 and §4.
//
// Everything here is deterministic given a Date, which is what makes the whole
// feature testable offline: scripts/sim-officercarry.js exercises month
// rollovers, year rollovers and the GMT+7 boundary without a Discord
// connection or a database.
//
// TIMEZONE APPROACH — the house pattern from gvg/capture.js: shift the instant
// by the offset, then do every calendar calculation with the getUTC* accessors
// on the shifted value. This avoids the process timezone entirely, which
// matters because Railway containers run UTC while the guild plays on GMT+7.
// A slot at Sunday 23:30 GMT+7 is Sunday 16:30 UTC, and it must land in the
// week that is ending, not the one starting.
// ---------------------------------------------------------------------------

const {
  TZ_OFFSET_HOURS,
  SLOT_MINUTES,
  WEEKDAY_WINDOW,
  WEEKEND_WINDOW,
  DAYS,
} = require('./constants');

const MS_PER_HOUR = 3_600_000;
const MS_PER_DAY = 86_400_000;
const OFFSET_MS = TZ_OFFSET_HOURS * MS_PER_HOUR;

const pad2 = n => String(n).padStart(2, '0');

// ---------------------------------------------------------------------------
// Offset helpers. `toLocal` returns a Date whose getUTC* accessors read as
// GMT+7 wall-clock; it is NOT a real instant and must never be persisted.
// `fromLocal` converts such a value back to the true instant.
// ---------------------------------------------------------------------------
function toLocal(date) {
  return new Date(date.getTime() + OFFSET_MS);
}

function fromLocal(localDate) {
  return new Date(localDate.getTime() - OFFSET_MS);
}

// ---------------------------------------------------------------------------
// Day helpers. DAYS is Monday-first; JS getUTCDay() is Sunday-first, so the
// (day + 6) % 7 shift converts between them. Getting this backwards silently
// moves the whole week by a day, so it lives in one place.
// ---------------------------------------------------------------------------
function dayIndexFromDate(localDate) {
  return (localDate.getUTCDay() + 6) % 7;   // 0 = Monday
}

function dayByKey(dayKey) {
  return DAYS.find(d => d.key === dayKey) || null;
}

function windowForDay(dayKey) {
  const day = dayByKey(dayKey);
  if (!day) return null;
  return day.weekend ? WEEKEND_WINDOW : WEEKDAY_WINDOW;
}

// ---------------------------------------------------------------------------
// Slot keys: `<dayKey>:<HHMM>` — e.g. 'mon:1800', 'sat:1230'. Derived from the
// grid, never free text, so a malformed id from a stale interaction cannot
// address a slot that does not exist.
// ---------------------------------------------------------------------------
function slotKey(dayKey, minutes) {
  return `${dayKey}:${pad2(Math.floor(minutes / 60))}${pad2(minutes % 60)}`;
}

function hhmm(minutes) {
  return `${pad2(Math.floor(minutes / 60))}:${pad2(minutes % 60)}`;
}

/** Minute-of-day values for one day, e.g. [1080, 1110, ... 1410]. */
function slotMinutesForDay(dayKey) {
  const win = windowForDay(dayKey);
  if (!win) return [];
  const out = [];
  for (let m = win.startMin; m < win.endMin; m += SLOT_MINUTES) out.push(m);
  return out;
}

/** Every slot key for one day, in chronological order. */
function slotKeysForDay(dayKey) {
  return slotMinutesForDay(dayKey).map(m => slotKey(dayKey, m));
}

/** Every slot key in the week, Monday 18:00 through Sunday 23:30. */
function allSlotKeys() {
  const out = [];
  for (const day of DAYS) out.push(...slotKeysForDay(day.key));
  return out;
}

/** Parse a slot key back into its parts. Returns null if it is not on the grid. */
function parseSlotKey(key) {
  if (typeof key !== 'string') return null;
  const m = /^([a-z]{3}):(\d{2})(\d{2})$/.exec(key);
  if (!m) return null;
  const [, dayKey, hh, mm] = m;
  const day = dayByKey(dayKey);
  if (!day) return null;
  const minutes = Number(hh) * 60 + Number(mm);
  // Validity is defined by membership of the day's own slot list, not by a
  // range check — that way an off-grid time like 18:07 is rejected too.
  if (!slotMinutesForDay(dayKey).includes(minutes)) return null;
  return { dayKey, day, minutes, hhmm: hhmm(minutes) };
}

// ---------------------------------------------------------------------------
// Week boundary. The week runs Monday 00:00 GMT+7 inclusive to the following
// Monday 00:00 GMT+7 exclusive (spec §4).
// ---------------------------------------------------------------------------
function weekStartAt(date = new Date()) {
  const local = toLocal(date);
  const daysSinceMonday = dayIndexFromDate(local);
  const localMondayMidnight = Date.UTC(
    local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() - daysSinceMonday,
    0, 0, 0, 0,
  );
  return fromLocal(new Date(localMondayMidnight));
}

function weekEndAt(date = new Date()) {
  return new Date(weekStartAt(date).getTime() + 7 * MS_PER_DAY);
}

// ---------------------------------------------------------------------------
// ISO-8601 week key, e.g. '2026-W36'. Thursday-based, so the ISO YEAR can
// differ from the calendar year in the first and last days of January and
// December — which is exactly why this is computed rather than assembled from
// getUTCFullYear() and a week counter.
// ---------------------------------------------------------------------------
function weekKey(date = new Date()) {
  const local = toLocal(date);
  // Midnight of the local day, then step to that ISO week's Thursday.
  const d = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()));
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7) + 3);
  const isoYear = d.getUTCFullYear();
  // Week 1 is the week containing 4 January, by definition.
  const jan4 = new Date(Date.UTC(isoYear, 0, 4));
  const week1Monday = new Date(Date.UTC(isoYear, 0, 4 - ((jan4.getUTCDay() + 6) % 7)));
  const week = 1 + Math.round((d.getTime() - week1Monday.getTime()) / (7 * MS_PER_DAY));
  return `${isoYear}-W${pad2(week)}`;
}

function weekDocId(guildId, key) {
  return `occarry:${guildId}:${key}`;
}

// ---------------------------------------------------------------------------
// Display helpers.
// ---------------------------------------------------------------------------
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** The calendar date a given day of the week falls on, as a local Date. */
function dateForDay(dayKey, weekStart) {
  const idx = DAYS.findIndex(d => d.key === dayKey);
  if (idx < 0) return null;
  return toLocal(new Date(weekStart.getTime() + idx * MS_PER_DAY));
}

/** e.g. 'Mon 01 Sep' for the board's per-day headings. */
function dayHeading(dayKey, weekStart) {
  const day = dayByKey(dayKey);
  const d = dateForDay(dayKey, weekStart);
  if (!day || !d) return dayKey;
  return `${day.label} ${pad2(d.getUTCDate())} ${MONTHS[d.getUTCMonth()]}`;
}

/** e.g. 'Mon 01 Sep' for the board title's "Week of ...". */
function weekHeading(weekStart) {
  return dayHeading('mon', weekStart);
}

/**
 * The true instant a slot starts, for ordering and for "already passed"
 * checks. Slot minutes can reach 23:30 but never 24:00, so this never rolls
 * into the following day.
 */
function slotStartAt(dayKey, minutes, weekStart) {
  const idx = DAYS.findIndex(d => d.key === dayKey);
  if (idx < 0) return null;
  return new Date(weekStart.getTime() + idx * MS_PER_DAY + minutes * 60_000);
}

module.exports = {
  toLocal,
  fromLocal,
  dayIndexFromDate,
  dayByKey,
  windowForDay,
  slotKey,
  hhmm,
  slotMinutesForDay,
  slotKeysForDay,
  allSlotKeys,
  parseSlotKey,
  weekStartAt,
  weekEndAt,
  weekKey,
  weekDocId,
  dateForDay,
  dayHeading,
  weekHeading,
  slotStartAt,
};
