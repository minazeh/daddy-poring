// ---------------------------------------------------------------------------
// GvG scheduler — next-occurrence math (GMT+7) + timer arm/cancel/re-arm.
//
// Each gvg_schedules doc gets THREE armed timers per weekly occurrence:
//   (a) capture       — fires at event start; the capture module opens the
//                       attendance window.
//   (b) reminder-start — fires at max(now, event−2h); the reminder module
//                       posts the Guild Event reminder sticky (Channel A).
//   (c) take-down     — fires at event start; the reminder module deletes the
//                       sticky + fires the Phase-2 final flush.
// Each timer SELF-RE-ARMS independently for the following week when it fires —
// they never cancel one another, so the capture/take-down pair (both at event
// start) can't race. Timers live in-memory only; ready.js calls armAll() on
// every boot so all three survive restarts, and /gvgschedule add|remove
// (re)arm/cancel all three together.
//
// Next-occurrence math: schedule times are wall-clock GMT+7 (see
// GVG_TZ_OFFSET_HOURS in gvg/constants.js). The instant is computed by
// shifting "now" into the GMT+7 frame, finding the next day-of-week + HH:MM
// there ("already past this week" rolls to next week), then shifting back to
// UTC. A whole week is ~604.8 M ms — comfortably inside Node's setTimeout cap
// (~2,147 M ms), so no long-delay chunking is needed.
// ---------------------------------------------------------------------------

const db = require('./db');
const { GVG_TZ_OFFSET_HOURS, DAY_INDEX, GVG_TZ_LABEL, REMINDER_LEAD_MS } = require('./constants');

const OFFSET_MS = GVG_TZ_OFFSET_HOURS * 3_600_000;
const WEEK_MS = 7 * 24 * 3_600_000;

// scheduleId (string) → active setTimeout handle, one Map per timer kind. Kept
// separate so a fire handler only ever touches its OWN kind (no sibling cancel).
const captureTimers = new Map();
const reminderStartTimers = new Map();
const takedownTimers = new Map();

// Injected from armAll() — called with (client, schedule[, eventAt]) when a
// timer fires. Kept injectable so tests can observe fires without requiring the
// capture/reminder modules (and to avoid any require cycle).
let onFire = null;           // capture: (client, schedule)
let onReminderStart = null;  // reminder: (client, schedule, eventAt)
let onTakedown = null;       // reminder: (client, schedule, eventAt)

// One-line label for logs.
function slotLabel(schedule) {
  return schedule.label || `${schedule.day} ${schedule.time} ${GVG_TZ_LABEL}`;
}

// ---------------------------------------------------------------------------
// nextOccurrence(day, time[, now]) — the next UTC Date at which the weekly
// GMT+7 wall-clock slot (day 'Monday'…'Sunday' + time 'HH:MM') occurs,
// strictly AFTER `now`. Exactly-now (or already past today) → next week.
// ---------------------------------------------------------------------------
function nextOccurrence(day, time, now = new Date()) {
  const targetDow = DAY_INDEX[day];
  const [h, m] = time.split(':').map(Number);

  // Shift into the GMT+7 frame: the UTC getters of `shifted` read as GMT+7
  // wall-clock components of `now`.
  const shifted = new Date(now.getTime() + OFFSET_MS);

  // Candidate: today's date in the GMT+7 frame at HH:MM, moved forward to the
  // target weekday.
  const cand = new Date(Date.UTC(
    shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate(), h, m, 0, 0,
  ));
  const dayDiff = (targetDow - shifted.getUTCDay() + 7) % 7;
  cand.setUTCDate(cand.getUTCDate() + dayDiff);

  // Same weekday but the slot already passed (or is exactly now) → next week.
  if (cand.getTime() <= shifted.getTime()) {
    cand.setUTCDate(cand.getUTCDate() + 7);
  }

  // Shift back out of the GMT+7 frame to the real UTC instant.
  return new Date(cand.getTime() - OFFSET_MS);
}

// ---------------------------------------------------------------------------
// (a) Capture timer — fires at event start; opens the attendance window and
// self-re-arms for next week. On fire now=event, so nextOccurrence rolls to
// next week (strictly-after-now). Re-arms ONLY the capture timer (never touches
// the take-down timer firing in the same tick).
// ---------------------------------------------------------------------------
function armCaptureTimer(client, schedule) {
  const id = String(schedule._id);
  const existing = captureTimers.get(id);
  if (existing) { clearTimeout(existing); captureTimers.delete(id); }

  const at = nextOccurrence(schedule.day, schedule.time);
  const delay = Math.max(0, at.getTime() - Date.now());

  const handle = setTimeout(() => {
    captureTimers.delete(id);
    try {
      if (onFire) {
        Promise.resolve(onFire(client, schedule)).catch(err =>
          console.warn(`[gvg/scheduler] Capture start failed for schedule ${id}:`, err?.message || err));
      }
    } catch (err) {
      console.warn(`[gvg/scheduler] Fire handler threw for schedule ${id}:`, err?.message || err);
    }
    armCaptureTimer(client, schedule); // weekly re-arm (self only)
  }, delay);
  if (typeof handle.unref === 'function') handle.unref();

  captureTimers.set(id, handle);
  console.log(`[gvg/scheduler] Armed capture "${slotLabel(schedule)}" (${id}) → fires ${at.toISOString()} (in ${Math.round(delay / 60000)} min).`);
  return at;
}

// ---------------------------------------------------------------------------
// (b) Reminder-start timer — fires at max(now, event−2h); the reminder module
// posts the sticky. If event is <2h out (or the computed start is already past)
// the delay clamps to 0 → fires immediately. Self-re-arm computes the occurrence
// STRICTLY AFTER this eventAt (next week) — else the just-fired window would
// re-arm to itself (start=event−2h already past) and loop.
// ---------------------------------------------------------------------------
function armReminderStartTimer(client, schedule, afterRef) {
  const id = String(schedule._id);
  const existing = reminderStartTimers.get(id);
  if (existing) { clearTimeout(existing); reminderStartTimers.delete(id); }

  const eventAt = nextOccurrence(schedule.day, schedule.time, afterRef || new Date());
  const startAt = eventAt.getTime() - REMINDER_LEAD_MS;
  const delay = Math.max(0, startAt - Date.now());

  const handle = setTimeout(() => {
    reminderStartTimers.delete(id);
    try {
      if (onReminderStart) {
        Promise.resolve(onReminderStart(client, schedule, eventAt)).catch(err =>
          console.warn(`[gvg/scheduler] Reminder-start failed for schedule ${id}:`, err?.message || err));
      }
    } catch (err) {
      console.warn(`[gvg/scheduler] Reminder-start handler threw for schedule ${id}:`, err?.message || err);
    }
    armReminderStartTimer(client, schedule, eventAt); // next week (strictly after)
  }, delay);
  if (typeof handle.unref === 'function') handle.unref();

  reminderStartTimers.set(id, handle);
  console.log(`[gvg/scheduler] Armed reminder-start "${slotLabel(schedule)}" (${id}) → posts ${new Date(startAt).toISOString()} (in ${Math.round(delay / 60000)} min) for event ${eventAt.toISOString()}.`);
  return eventAt;
}

// ---------------------------------------------------------------------------
// (c) Take-down timer — fires at event start; the reminder module deletes the
// sticky + fires the final flush. Self-re-arm computes STRICTLY AFTER this
// eventAt (next week). Runs in the same tick as the capture timer but in a
// separate Map, so neither cancels the other.
// ---------------------------------------------------------------------------
function armTakedownTimer(client, schedule, afterRef) {
  const id = String(schedule._id);
  const existing = takedownTimers.get(id);
  if (existing) { clearTimeout(existing); takedownTimers.delete(id); }

  const eventAt = nextOccurrence(schedule.day, schedule.time, afterRef || new Date());
  const delay = Math.max(0, eventAt.getTime() - Date.now());

  const handle = setTimeout(() => {
    takedownTimers.delete(id);
    try {
      if (onTakedown) {
        Promise.resolve(onTakedown(client, schedule, eventAt)).catch(err =>
          console.warn(`[gvg/scheduler] Take-down failed for schedule ${id}:`, err?.message || err));
      }
    } catch (err) {
      console.warn(`[gvg/scheduler] Take-down handler threw for schedule ${id}:`, err?.message || err);
    }
    armTakedownTimer(client, schedule, eventAt); // next week (strictly after)
  }, delay);
  if (typeof handle.unref === 'function') handle.unref();

  takedownTimers.set(id, handle);
  console.log(`[gvg/scheduler] Armed take-down "${slotLabel(schedule)}" (${id}) → fires ${eventAt.toISOString()} (in ${Math.round(delay / 60000)} min).`);
  return eventAt;
}

// ---------------------------------------------------------------------------
// Arm ONE schedule: (re)arm all three timers. Each armXTimer clears its own
// prior handle first, so this is safe to call repeatedly (add / re-sync).
// Returns the capture fire time (used by /gvgschedule add's confirmation).
// ---------------------------------------------------------------------------
function armSchedule(client, schedule) {
  const at = armCaptureTimer(client, schedule);
  armReminderStartTimer(client, schedule);
  armTakedownTimer(client, schedule);
  return at;
}

// Cancel ALL of one schedule's timers (no-op for any not armed). Used by
// /gvgschedule remove — cancels capture + reminder-start + take-down together.
function cancelSchedule(id) {
  const key = String(id);
  for (const map of [captureTimers, reminderStartTimers, takedownTimers]) {
    const handle = map.get(key);
    if (handle) { clearTimeout(handle); map.delete(key); }
  }
}

// Cancel everything (used by armAll to start clean; available for shutdown).
function cancelAll() {
  for (const map of [captureTimers, reminderStartTimers, takedownTimers]) {
    for (const handle of map.values()) clearTimeout(handle);
    map.clear();
  }
}

// ---------------------------------------------------------------------------
// Arm ALL schedules from the DB (boot + safety re-sync). fireHandler is the
// capture module's startCapture; reminderHooks = { onReminderStart, onTakedown }
// from the reminder module. All are stored for subsequent armSchedule calls
// from the add command too. Never throws to the boot path.
// ---------------------------------------------------------------------------
async function armAll(client, fireHandler, reminderHooks) {
  if (fireHandler) onFire = fireHandler;
  if (reminderHooks) {
    if (reminderHooks.onReminderStart) onReminderStart = reminderHooks.onReminderStart;
    if (reminderHooks.onTakedown) onTakedown = reminderHooks.onTakedown;
  }
  try {
    cancelAll();
    const schedules = await db.getSchedules();
    for (const schedule of schedules) {
      armSchedule(client, schedule);
    }
    console.log(`[gvg/scheduler] Armed ${schedules.length} schedule(s) (capture + reminder + take-down).`);
    return schedules.length;
  } catch (err) {
    console.warn('[gvg/scheduler] armAll failed (GvG timers not armed, bot still online):', err?.message || err);
    return 0;
  }
}

// Test/introspection helpers.
function _setOnFireForTests(fn) { onFire = fn; }
function _setReminderHooksForTests({ onReminderStart: rs, onTakedown: td } = {}) {
  if (rs) onReminderStart = rs;
  if (td) onTakedown = td;
}
function _armedIds() { return [...captureTimers.keys()]; }
function _armedReminderStartIds() { return [...reminderStartTimers.keys()]; }
function _armedTakedownIds() { return [...takedownTimers.keys()]; }

module.exports = {
  nextOccurrence,
  armSchedule,
  cancelSchedule,
  cancelAll,
  armAll,
  WEEK_MS,
  _setOnFireForTests,
  _setReminderHooksForTests,
  _armedIds,
  _armedReminderStartIds,
  _armedTakedownIds,
};
