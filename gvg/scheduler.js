// ---------------------------------------------------------------------------
// GvG scheduler — next-occurrence math (GMT+7) + timer arm/cancel/re-arm.
//
// Each gvg_schedules doc gets ONE armed setTimeout for its next weekly
// occurrence. When it fires, the capture module starts the attendance window
// and the scheduler immediately re-arms for the following week. Timers live
// in-memory only; ready.js calls armAll() on every boot so schedules survive
// restarts, and /gvgschedule add|remove (re)arm/cancel individual timers.
//
// Next-occurrence math: schedule times are wall-clock GMT+7 (see
// GVG_TZ_OFFSET_HOURS in gvg/constants.js). The instant is computed by
// shifting "now" into the GMT+7 frame, finding the next day-of-week + HH:MM
// there ("already past this week" rolls to next week), then shifting back to
// UTC. A whole week is ~604.8 M ms — comfortably inside Node's setTimeout cap
// (~2,147 M ms), so no long-delay chunking is needed.
// ---------------------------------------------------------------------------

const db = require('./db');
const { GVG_TZ_OFFSET_HOURS, DAY_INDEX } = require('./constants');

const OFFSET_MS = GVG_TZ_OFFSET_HOURS * 3_600_000;
const WEEK_MS = 7 * 24 * 3_600_000;

// scheduleId (string) → active setTimeout handle.
const timers = new Map();

// Injected once from armAll()/armSchedule() — called with (client, schedule)
// when a schedule fires. Kept injectable so tests can observe fires without
// requiring the capture module (and to avoid a require cycle).
let onFire = null;

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
// Arm ONE schedule: cancel any existing timer for it, compute the next
// occurrence, set the timer. On fire: hand off to the capture module
// (fire-and-forget — a capture error must not kill re-arming) and re-arm for
// the following week.
// ---------------------------------------------------------------------------
function armSchedule(client, schedule) {
  const id = String(schedule._id);
  cancelSchedule(id);

  const at = nextOccurrence(schedule.day, schedule.time);
  const delay = Math.max(0, at.getTime() - Date.now());

  const handle = setTimeout(() => {
    timers.delete(id);
    try {
      if (onFire) {
        Promise.resolve(onFire(client, schedule)).catch(err =>
          console.warn(`[gvg/scheduler] Capture start failed for schedule ${id}:`, err?.message || err));
      }
    } catch (err) {
      console.warn(`[gvg/scheduler] Fire handler threw for schedule ${id}:`, err?.message || err);
    }
    // Weekly recurrence — re-arm immediately for next week. Re-reads nothing;
    // if the schedule was removed mid-window, /gvgschedule remove already
    // cancelled this timer, so reaching here means it still existed at fire
    // time. A remove AFTER this re-arm cancels the new timer via the Map.
    armSchedule(client, schedule);
  }, delay);

  // Don't let a pending GvG timer keep a dying process alive.
  if (typeof handle.unref === 'function') handle.unref();

  timers.set(id, handle);
  console.log(`[gvg/scheduler] Armed "${schedule.label || schedule.day + ' ' + schedule.time}" (${id}) → fires ${at.toISOString()} (in ${Math.round(delay / 60000)} min).`);
  return at;
}

// Cancel one schedule's timer (no-op if none armed).
function cancelSchedule(id) {
  const key = String(id);
  const handle = timers.get(key);
  if (handle) {
    clearTimeout(handle);
    timers.delete(key);
  }
}

// Cancel everything (used by armAll to start clean; available for shutdown).
function cancelAll() {
  for (const handle of timers.values()) clearTimeout(handle);
  timers.clear();
}

// ---------------------------------------------------------------------------
// Arm ALL schedules from the DB (boot + safety re-sync). fireHandler is the
// capture module's startCapture; it's stored for subsequent armSchedule calls
// from the add command too. Never throws to the boot path.
// ---------------------------------------------------------------------------
async function armAll(client, fireHandler) {
  if (fireHandler) onFire = fireHandler;
  try {
    cancelAll();
    const schedules = await db.getSchedules();
    for (const schedule of schedules) {
      armSchedule(client, schedule);
    }
    console.log(`[gvg/scheduler] Armed ${schedules.length} schedule(s).`);
    return schedules.length;
  } catch (err) {
    console.warn('[gvg/scheduler] armAll failed (GvG timers not armed, bot still online):', err?.message || err);
    return 0;
  }
}

// Test/introspection helpers.
function _setOnFireForTests(fn) { onFire = fn; }
function _armedIds() { return [...timers.keys()]; }

module.exports = {
  nextOccurrence,
  armSchedule,
  cancelSchedule,
  cancelAll,
  armAll,
  WEEK_MS,
  _setOnFireForTests,
  _armedIds,
};
